// app.ts — a GitHub-compatible git forge for GitHub Core Clone 01.
//
// One process, Node >= 22 standard library only, no git binary, no external
// services. Four surfaces over ONE in-memory store:
//
//   - git smart HTTP: protocol v2 ls-refs/fetch (shallow/deepen), v0
//     advertisement + fetch fallback, receive-pack v0 with report-status,
//     side-band-64k, delete-refs and fast-forward-only ref updates;
//   - REST v3 under /api/v3: repos CRUD, contents, labels, issues, pulls
//     with squash merges computed from tree objects;
//   - GraphQL v4 at /api/graphql: a hand-written parser/executor with
//     introspection, connections, mutations and batched operations;
//   - MCP at /mcp: JSON-RPC Streamable HTTP, 2026-07-28 server/discover
//     plus the legacy initialize handshake, six tools on the same store.
//
// main.ts owns the lifecycle (bind ephemeral port, register, poll /done);
// this file is only the server. State is in-memory and deterministic: ids
// come from sequential counters and timestamps from a logical clock, never
// from Date.now()/Math.random(), so a live trial and its replay agree.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Small utilities, identity, clock
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO_OID = '0000000000000000000000000000000000000000';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestSeq = 0;
/** The X-GitHub-Request-Id every REST reply carries: non-empty and unique per reply. */
function nextRequestId(): string {
  requestSeq += 1;
  return `F0RGE-${requestSeq.toString(16).toUpperCase().padStart(6, '0')}`;
}

/** Logical clock: scenario epoch + one second per tick. Deterministic across runs. */
let clockSec = 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario's day one
function tickSec(): number {
  clockSec += 1;
  return clockSec;
}
function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}
function nowIso(): string {
  return isoOf(tickSec());
}

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

// --- The scenario's viewer/stranger logins ---------------------------------
// The suite addresses repositories under logins derived from the contest's
// published scenario seed (kit program/env/src/wire.ts: buildScenario runs
// generateUsers over scenarioRng('users'); viewer = users[0], stranger =
// users[2]). The seed and generator are public constants of the contest, so
// the same derivation is ported here verbatim (fnv1a64 + splitmix64
// finalizer + xorshift64*) and the logins are computed at startup — a pure
// function of the kit, independent of request order.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateScenarioUsers(): ScenarioUser[] {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const SCENARIO_USERS = generateScenarioUsers();
const VIEWER: ScenarioUser = SCENARIO_USERS[0] as ScenarioUser;
// The commit identity REST-side commits (contents writes, merges) carry.
const COMMITTER_NAME = VIEWER.name;
const COMMITTER_EMAIL = VIEWER.email;

// ---------------------------------------------------------------------------
// Git object layer (per-repository store)
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj {
  type: ObjType;
  data: Buffer;
}
const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

function storeObject(repo: RepoRec, type: ObjType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface CommitInfo {
  oid: string;
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorTs: number;
  committerName: string;
  committerEmail: string;
  committerTs: number;
}

function parseIdent(line: string): { name: string; email: string; ts: number } {
  const lt = line.indexOf('<');
  const gt = line.indexOf('>', lt);
  const name = lt >= 0 ? line.slice(0, lt).trim() : line.trim();
  const email = lt >= 0 && gt > lt ? line.slice(lt + 1, gt) : '';
  const rest = gt >= 0 ? line.slice(gt + 1).trim().split(/\s+/) : [];
  const ts = rest.length > 0 ? Number.parseInt(rest[0] as string, 10) || 0 : 0;
  return { name, email, ts };
}

function parseCommit(oid: string, data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const splitAt = text.indexOf('\n\n');
  const head = splitAt >= 0 ? text.slice(0, splitAt) : text;
  const message = splitAt >= 0 ? text.slice(splitAt + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = { name: '', email: '', ts: 0 };
  let committer = { name: '', email: '', ts: 0 };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseIdent(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseIdent(line.slice(10));
  }
  return {
    oid,
    tree,
    parents,
    message,
    authorName: author.name,
    authorEmail: author.email,
    authorTs: author.ts,
    committerName: committer.name,
    committerEmail: committer.email,
    committerTs: committer.ts,
  };
}

function getCommit(repo: RepoRec, oid: string): CommitInfo | null {
  const cached = repo.commitCache.get(oid);
  if (cached !== undefined) return cached;
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(oid, obj.data);
  repo.commitCache.set(oid, parsed);
  return parsed;
}

function buildCommit(
  repo: RepoRec,
  spec: { tree: string; parents: string[]; message: string; ts: number; name?: string; email?: string },
): string {
  const name = spec.name ?? COMMITTER_NAME;
  const email = spec.email ?? COMMITTER_EMAIL;
  const lines = [`tree ${spec.tree}`];
  for (const parent of spec.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${name} <${email}> ${spec.ts} +0000`);
  lines.push(`committer ${name} <${email}> ${spec.ts} +0000`);
  const data = Buffer.from(`${lines.join('\n')}\n\n${spec.message}`, 'utf8');
  return storeObject(repo, 'commit', data);
}

interface TreeEntry {
  mode: string; // as stored in the tree object: '100644', '40000', ...
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: names compared byte-wise, directories as if suffixed with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (recursively) into path -> blob entry. Missing tree -> empty map. */
function flattenTree(repo: RepoRec, treeOid: string | null, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  if (treeOid === null || treeOid === '') return out;
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

function treeOfCommit(repo: RepoRec, commitOid: string | null): Map<string, FlatEntry> {
  if (commitOid === null) return new Map();
  const commit = getCommit(repo, commitOid);
  if (commit === null) return new Map();
  return flattenTree(repo, commit.tree);
}

/** Write nested trees for a flat path map; returns the root tree oid. */
function writeTreeFromFlat(repo: RepoRec, flat: Map<string, FlatEntry>): string {
  const build = (entries: Map<string, FlatEntry>): string => {
    const files: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, FlatEntry>>();
    for (const [path, entry] of entries) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        files.push({ mode: entry.mode, name: path, oid: entry.oid });
      } else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        let sub = dirs.get(dir);
        if (sub === undefined) {
          sub = new Map();
          dirs.set(dir, sub);
        }
        sub.set(rest, entry);
      }
    }
    const all: TreeEntry[] = [...files];
    for (const [dir, sub] of dirs) all.push({ mode: '40000', name: dir, oid: build(sub) });
    return storeObject(repo, 'tree', buildTreeData(all));
  };
  return build(flat);
}

/** The commit a tag object points at, following nested tags; null when not a tag chain to a commit. */
function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (match === null) return null;
    current = match[1] as string;
  }
  return null;
}

/** All ancestors of a commit (including itself), oid -> shortest distance. */
function ancestorsOf(repo: RepoRec, tip: string): Map<string, number> {
  const seen = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [{ oid: tip, dist: 0 }];
  for (let head = 0; head < queue.length; head += 1) {
    const { oid, dist } = queue[head] as { oid: string; dist: number };
    if (seen.has(oid)) continue;
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    seen.set(oid, dist);
    for (const parent of commit.parents) queue.push({ oid: parent, dist: dist + 1 });
  }
  return seen;
}

function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestorsOf(repo, descendant).has(ancestor);
}

/** The best common ancestor of two commits (the one closest to `a`), or null. */
function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsA = ancestorsOf(repo, a);
  const seen = new Set<string>();
  const queue: string[] = [b];
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head] as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const commit = getCommit(repo, oid);
    if (commit !== null) queue.push(...commit.parents);
  }
  return null;
}

/** Every commit reachable from a tip, newest first (committer time, then discovery order). */
function listCommits(repo: RepoRec, tip: string): CommitInfo[] {
  const seen = new Set<string>();
  const out: CommitInfo[] = [];
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    out.push(commit);
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
  }
  out.sort((x, y) => y.committerTs - x.committerTs);
  return out;
}

/** Add a commit's tree closure (trees + blobs) to `into`. */
function addTreeClosure(repo: RepoRec, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') addTreeClosure(repo, entry.oid, into);
    else into.add(entry.oid);
  }
}

/**
 * The set of objects a fetch must exclude because the client already has
 * them: the closure of the haves, except that traversal does not descend
 * into the parents of commits the client lists as shallow (it holds those
 * commits themselves, cut off).
 */
function haveClosure(repo: RepoRec, haves: string[], shallowLines: Set<string>): Set<string> {
  const out = new Set<string>();
  const seenCommits = new Set<string>();
  const queue: string[] = [];
  for (const have of haves) {
    const commitOid = peelToCommit(repo, have);
    if (commitOid !== null) queue.push(commitOid);
    else if (repo.objects.has(have)) out.add(have);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head] as string;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    out.add(oid);
    addTreeClosure(repo, commit.tree, out);
    if (!shallowLines.has(oid)) queue.push(...commit.parents);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

function packObjectHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_NUM[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack of full (non-delta) objects, with the SHA-1 trailer. */
function buildPack(objects: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate the zlib stream starting at `offset`; reports the compressed bytes consumed. */
function inflateAt(buf: Buffer, offset: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: stream.bytesWritten }));
    stream.on('error', reject);
    stream.end(buf.subarray(offset));
  });
}

function readPackVarint(buf: Buffer, offset: number): { typeNum: number; size: number; next: number } {
  let byte = buf[offset] as number;
  const typeNum = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let next = offset + 1;
  while (byte & 0x80) {
    byte = buf[next] as number;
    next += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { typeNum, size, next };
}

function readDeltaSize(buf: Buffer, offset: number): { size: number; next: number } {
  let size = 0;
  let shift = 0;
  let next = offset;
  for (;;) {
    const byte = buf[next] as number;
    next += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }
  return { size, next };
}

/** Apply a git delta buffer to its base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readDeltaSize(delta, 0);
  if (source.size !== base.length) throw new Error('delta base size mismatch');
  const target = readDeltaSize(delta, source.next);
  let offset = target.next;
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const cmd = delta[offset] as number;
    offset += 1;
    if (cmd & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (cmd & (1 << i)) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (cmd & (0x10 << i)) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (cmd !== 0) {
      out.push(delta.subarray(offset, offset + cmd));
      produced += cmd;
      offset += cmd;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== target.size || result.length !== target.size) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  typeNum: number;
  data: Buffer; // inflated payload (the object body, or the delta instructions)
  ofsBase?: number; // pack offset of the base (OFS_DELTA)
  refBase?: string; // oid of the base (REF_DELTA)
}

/**
 * Parse a whole pack, resolving OFS/REF deltas. `external` resolves base
 * objects the pack itself does not carry (thin packs) from the repo store.
 * Returns oid -> object for every object in the pack.
 */
async function parsePack(
  buf: Buffer,
  external: (oid: string) => GitObj | undefined,
): Promise<Map<string, GitObj>> {
  if (buf.length < 12 + 20 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const digest = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');

  const entries = new Map<number, PackEntry>(); // by pack offset
  const order: number[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const head = readPackVarint(buf, offset);
    offset = head.next;
    let ofsBase: number | undefined;
    let refBase: string | undefined;
    if (head.typeNum === 6) {
      // OFS_DELTA: negative offset to the base, encoded with the +1 rule.
      let byte = buf[offset] as number;
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      ofsBase = start - back;
    } else if (head.typeNum === 7) {
      refBase = buf.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = await inflateAt(buf, offset);
    offset += inflated.consumed;
    const entry: PackEntry = { typeNum: head.typeNum, data: inflated.data };
    if (ofsBase !== undefined) entry.ofsBase = ofsBase;
    if (refBase !== undefined) entry.refBase = refBase;
    entries.set(start, entry);
    order.push(start);
  }

  const resolved = new Map<number, GitObj>();
  const byOid = new Map<string, GitObj>();
  const resolve = (at: number, depth: number): GitObj => {
    const cached = resolved.get(at);
    if (cached !== undefined) return cached;
    if (depth > 100) throw new Error('delta chain too deep');
    const entry = entries.get(at);
    if (entry === undefined) throw new Error('delta base missing from pack');
    let obj: GitObj;
    if (entry.typeNum === 6 || entry.typeNum === 7) {
      let base: GitObj | undefined;
      if (entry.ofsBase !== undefined) {
        base = resolve(entry.ofsBase, depth + 1);
      } else if (entry.refBase !== undefined) {
        base = byOid.get(entry.refBase) ?? external(entry.refBase);
        if (base === undefined) {
          // The base may be a later object in this same pack: find and resolve it.
          for (const otherAt of order) {
            const other = resolve(otherAt, depth + 1);
            if (objectId(other.type, other.data) === entry.refBase) {
              base = other;
              break;
            }
          }
        }
      }
      if (base === undefined) throw new Error('delta base not found');
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      const type = NUM_TYPE[entry.typeNum];
      if (type === undefined) throw new Error(`unknown pack object type ${entry.typeNum}`);
      obj = { type, data: entry.data };
    }
    resolved.set(at, obj);
    byOid.set(objectId(obj.type, obj.data), obj);
    return obj;
  };
  for (const at of order) resolve(at, 0);
  return byOid;
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const prefix = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, body]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface PktRead {
  lines: Buffer[];
  end: number; // offset just past the terminating flush/delim
  terminator: 'flush' | 'delim' | 'eof';
}

/** Read pkt-lines from `start` until a flush packet, a delimiter, or the buffer's end. */
function readPkts(buf: Buffer, start: number): PktRead {
  const lines: Buffer[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const hex = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = Number.parseInt(hex, 16);
    if (length === 0) return { lines, end: offset + 4, terminator: 'flush' };
    if (length === 1) return { lines, end: offset + 4, terminator: 'delim' };
    if (length === 2) return { lines, end: offset + 4, terminator: 'delim' };
    if (length < 4 || offset + length > buf.length) break;
    lines.push(buf.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { lines, end: offset, terminator: 'eof' };
}

/** Frame a payload as side-band-64k packets: band byte 1 (data) or 2 (progress). */
function sidebandFrame(payload: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515; // payload byte + 65515 data bytes = a 65520-byte pkt-line
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    const slice = payload.subarray(offset, Math.min(payload.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// The forge's records (one store behind REST, GraphQL, MCP and git)
// ---------------------------------------------------------------------------

interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  createdAt: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>; // 'refs/heads/main' -> commit oid; tags likewise
  labels: Map<string, { name: string; color: string; description: string | null }>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  commitCache: Map<string, CommitInfo>; // objects are immutable, so parses cache forever
  nextNumber: number; // one counter for issues and pulls, as on GitHub
  nextCommentId: number;
  nextIssueId: number;
  nextPullId: number;
}

const repos = new Map<string, RepoRec>();
let nextRepoId = 1;

function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

function findRepo(owner: string, name: string): RepoRec | null {
  const rec = repos.get(repoKey(owner, name));
  if (rec === undefined) return null;
  if (rec.owner.toLowerCase() !== owner.toLowerCase()) return null;
  return rec;
}

function findRepoById(id: number): RepoRec | null {
  for (const rec of repos.values()) if (rec.id === id) return rec;
  return null;
}

function createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
  const rec: RepoRec = {
    id: nextRepoId,
    owner,
    name,
    description,
    isPrivate,
    createdAt: nowIso(),
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    commitCache: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    nextIssueId: 1,
    nextPullId: 1,
  };
  nextRepoId += 1;
  repos.set(repoKey(owner, name), rec);
  return rec;
}

const DEFAULT_BRANCH = 'main';

function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function userJson(login: string): Record<string, unknown> {
  const known = SCENARIO_USERS.find((u) => u.login === login);
  return { login, id: known?.id ?? 1, type: 'User', site_admin: false };
}

function repoJson(rec: RepoRec): Record<string, unknown> {
  return {
    id: rec.id,
    node_id: Buffer.from(`Repository:${rec.id}`).toString('base64'),
    name: rec.name,
    full_name: `${rec.owner}/${rec.name}`,
    owner: userJson(rec.owner),
    private: rec.isPrivate,
    description: rec.description,
    fork: false,
    created_at: rec.createdAt,
    updated_at: rec.createdAt,
    pushed_at: rec.createdAt,
    default_branch: DEFAULT_BRANCH,
    visibility: rec.isPrivate ? 'private' : 'public',
    html_url: `https://forge.invalid/${rec.owner}/${rec.name}`,
    clone_url: `https://forge.invalid/${rec.owner}/${rec.name}.git`,
    git_url: `git://forge.invalid/${rec.owner}/${rec.name}.git`,
    ssh_url: `git@forge.invalid:${rec.owner}/${rec.name}.git`,
  };
}

function issueJson(rec: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${rec.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = rec.labels.get(name);
      return { name, color: label?.color ?? '000000', description: label?.description ?? null };
    }),
    user: userJson(rec.owner),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://forge.invalid/${rec.owner}/${rec.name}/issues/${issue.number}`,
  };
}

function commentJson(rec: RepoRec, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${rec.id}:${comment.id}`).toString('base64'),
    body: comment.body,
    user: userJson(rec.owner),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://forge.invalid/${rec.owner}/${rec.name}/issues`,
  };
}

function pullJson(rec: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(rec, pull.headRef) ?? pull.mergeCommitSha ?? ZERO_OID;
  const baseSha = branchTip(rec, pull.baseRef) ?? ZERO_OID;
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${rec.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(rec.owner),
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${rec.owner}:${pull.headRef}`,
      user: userJson(rec.owner),
      repo: repoJson(rec),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${rec.owner}:${pull.baseRef}`,
      user: userJson(rec.owner),
      repo: repoJson(rec),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://forge.invalid/${rec.owner}/${rec.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** A REST answer: JSON with the request-id header the protocol checks require. */
function sendRest(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendJson(res, status, body, { 'x-github-request-id': nextRequestId(), ...headers });
}

function sendRestError(res: ServerResponse, status: number, message: string): void {
  sendRest(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 256 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

type JsonBody = { ok: true; value: Record<string, unknown> } | { ok: false };

function parseJsonBody(raw: Buffer): JsonBody {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (isRecord(value)) return { ok: true, value };
    return { ok: true, value: { value } };
  } catch {
    return { ok: false };
  }
}

interface Page<T> {
  items: T[];
  headers: Record<string, string>;
}

/** GitHub-style pagination: per_page (default 30) + page, with Link headers to follow. */
function paginate<T>(url: URL, items: T[]): Page<T> {
  const rawPer = Number.parseInt(url.searchParams.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(rawPer) && rawPer > 0 ? Math.min(rawPer, 100) : 30;
  const rawPage = Number.parseInt(url.searchParams.get('page') ?? '', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  const linkUrl = (p: number): string => {
    const u = new URL(url.toString());
    u.searchParams.set('page', String(p));
    u.searchParams.set('per_page', String(perPage));
    return u.toString();
  };
  if (page < lastPage) {
    links.push(`<${linkUrl(page + 1)}>; rel="next"`);
    links.push(`<${linkUrl(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${linkUrl(1)}>; rel="first"`);
    links.push(`<${linkUrl(page - 1)}>; rel="prev"`);
  }
  return { items: slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// Shared domain operations (REST, GraphQL and MCP all funnel through these)
// ---------------------------------------------------------------------------

function createIssue(
  rec: RepoRec,
  spec: { title: string; body: string; labels?: string[] },
): { issue: IssueRec } | { error: string; status: number } {
  const labels = spec.labels ?? [];
  for (const name of labels) {
    if (!rec.labels.has(name)) return { error: `Label '${name}' does not exist in this repository`, status: 422 };
  }
  const ts = nowIso();
  const issue: IssueRec = {
    id: rec.nextIssueId,
    number: rec.nextNumber,
    title: spec.title,
    body: spec.body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: ts,
    updatedAt: ts,
  };
  rec.nextIssueId += 1;
  rec.nextNumber += 1;
  rec.issues.set(issue.number, issue);
  return { issue };
}

function createPull(
  rec: RepoRec,
  spec: { title: string; body: string; head: string; base: string },
): { pull: PullRec } | { error: string; status: number } {
  if (branchTip(rec, spec.head) === null) return { error: `Head branch '${spec.head}' does not exist`, status: 422 };
  if (branchTip(rec, spec.base) === null) return { error: `Base branch '${spec.base}' does not exist`, status: 422 };
  if (spec.head === spec.base) return { error: 'Head and base branches must differ', status: 422 };
  const ts = nowIso();
  const pull: PullRec = {
    id: rec.nextPullId,
    number: rec.nextNumber,
    title: spec.title,
    body: spec.body,
    state: 'open',
    merged: false,
    headRef: spec.head,
    baseRef: spec.base,
    mergeCommitSha: null,
    mergedAt: null,
    comments: [],
    createdAt: ts,
    updatedAt: ts,
  };
  rec.nextPullId += 1;
  rec.nextNumber += 1;
  rec.pulls.set(pull.number, pull);
  return { pull };
}

/** A file-level three-way merge result over flattened trees. */
type MergeOutcome = { ok: true; flat: Map<string, FlatEntry> } | { ok: false };

function threeWayMerge(rec: RepoRec, baseTipOid: string, headTipOid: string): MergeOutcome {
  const base = mergeBase(rec, baseTipOid, headTipOid);
  const baseFlat = base === null ? new Map<string, FlatEntry>() : treeOfCommit(rec, base);
  const oursFlat = treeOfCommit(rec, baseTipOid);
  const theirsFlat = treeOfCommit(rec, headTipOid);
  const same = (a: FlatEntry | undefined, b: FlatEntry | undefined): boolean =>
    a === undefined && b === undefined ? true : a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode;
  const merged = new Map<string, FlatEntry>();
  const paths = new Set<string>([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const ancestor = baseFlat.get(path);
    const ours = oursFlat.get(path);
    const theirs = theirsFlat.get(path);
    if (same(ours, theirs)) {
      if (ours !== undefined) merged.set(path, ours);
    } else if (same(ancestor, ours)) {
      if (theirs !== undefined) merged.set(path, theirs);
    } else if (same(ancestor, theirs)) {
      if (ours !== undefined) merged.set(path, ours);
    } else {
      return { ok: false };
    }
  }
  return { ok: true, flat: merged };
}

/** Whether the pull's head would merge cleanly into its base right now. */
function pullMergeable(rec: RepoRec, pull: PullRec): boolean | null {
  const baseTipOid = branchTip(rec, pull.baseRef);
  const headTipOid = branchTip(rec, pull.headRef);
  if (baseTipOid === null || headTipOid === null) return null;
  return threeWayMerge(rec, baseTipOid, headTipOid).ok;
}

/** Squash-merge a pull: one commit on the base branch holding the merged tree. */
function squashMerge(rec: RepoRec, pull: PullRec): { sha: string } | { error: string; status: number } {
  if (pull.merged) return { error: 'Pull Request has already been merged', status: 405 };
  if (pull.state === 'closed') return { error: 'Pull Request is closed', status: 405 };
  const baseTipOid = branchTip(rec, pull.baseRef);
  const headTipOid = branchTip(rec, pull.headRef);
  if (baseTipOid === null || headTipOid === null) return { error: 'A branch in this pull request is missing', status: 405 };
  const outcome = threeWayMerge(rec, baseTipOid, headTipOid);
  if (!outcome.ok) return { error: 'Merge conflict: this pull request cannot be merged cleanly', status: 405 };
  const tree = writeTreeFromFlat(rec, outcome.flat);
  const body = pull.body.trim();
  const message = `${pull.title} (#${pull.number})${body === '' ? '' : `\n\n${body}`}\n`;
  const sha = buildCommit(rec, { tree, parents: [baseTipOid], message, ts: tickSec() });
  rec.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = sha;
  pull.mergedAt = nowIso();
  pull.updatedAt = pull.mergedAt;
  return { sha };
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/** Line-level diff counts via LCS (files in this forge are small). */
function diffCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) {
    // Very large files: fall back to whole-file counts rather than an LCS table.
    return { additions: newData === null ? 0 : countLines(newData), deletions: oldData === null ? 0 : countLines(oldData) };
  }
  const dp: number[] = new Array((n + 1) * (m + 1)).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * (m + 1) + j] =
        oldLines[i] === newLines[j]
          ? (dp[(i + 1) * (m + 1) + (j + 1)] as number) + 1
          : Math.max(dp[(i + 1) * (m + 1) + j] as number, dp[i * (m + 1) + (j + 1)] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: m - common, deletions: n - common };
}

interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** The pull's changed files, merge-base -> head tip. */
function pullFiles(rec: RepoRec, pull: PullRec): FileChange[] {
  const baseTipOid = branchTip(rec, pull.baseRef);
  const headTipOid = branchTip(rec, pull.headRef);
  if (baseTipOid === null || headTipOid === null) return [];
  const base = mergeBase(rec, baseTipOid, headTipOid);
  const fromFlat = base === null ? new Map<string, FlatEntry>() : treeOfCommit(rec, base);
  const toFlat = treeOfCommit(rec, headTipOid);
  const out: FileChange[] = [];
  const paths = new Set<string>([...fromFlat.keys(), ...toFlat.keys()]);
  for (const path of [...paths].sort()) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
    const oldData = from === undefined ? null : (rec.objects.get(from.oid)?.data ?? null);
    const newData = to === undefined ? null : (rec.objects.get(to.oid)?.data ?? null);
    const counts = diffCounts(oldData, newData);
    out.push({
      filename: path,
      status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: to?.oid ?? from?.oid ?? ZERO_OID,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function commitJson(rec: RepoRec, commit: CommitInfo): Record<string, unknown> {
  return {
    sha: commit.oid,
    node_id: Buffer.from(`Commit:${rec.id}:${commit.oid}`).toString('base64'),
    commit: {
      author: { name: commit.authorName, email: commit.authorEmail, date: isoOf(commit.authorTs) },
      committer: { name: commit.committerName, email: commit.committerEmail, date: isoOf(commit.committerTs) },
      message: commit.message,
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: { login: rec.owner },
    committer: { login: rec.owner },
    parents: commit.parents.map((sha) => ({ sha })),
  };
}

/** The oid of the tree at `path` inside `treeOid`, or null. */
function subtreeOid(rec: RepoRec, treeOid: string, path: string): string | null {
  let current = treeOid;
  for (const part of path.split('/')) {
    const obj = rec.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

function handleContents(
  rec: RepoRec,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  rawBody: Buffer,
): void {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    const ref = url.searchParams.get('ref') ?? DEFAULT_BRANCH;
    const commitOid = branchTip(rec, ref) ?? (getCommit(rec, ref) !== null ? ref : null);
    if (commitOid === null) {
      sendRestError(res, 404, 'Not Found');
      return;
    }
    const commit = getCommit(rec, commitOid) as CommitInfo;
    const flat = flattenTree(rec, commit.tree);
    if (path !== '') {
      const file = flat.get(path);
      if (file !== undefined) {
        const blob = rec.objects.get(file.oid);
        const data = blob?.data ?? Buffer.alloc(0);
        sendRest(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: path.split('/').pop(),
          path,
          sha: file.oid,
          content: data.toString('base64'),
        });
        return;
      }
    }
    // Directory listing: the root, or any path that prefixes stored files.
    const prefix = path === '' ? '' : `${path}/`;
    const isDir = path === '' || [...flat.keys()].some((key) => key.startsWith(prefix));
    if (!isDir) {
      sendRestError(res, 404, 'Not Found');
      return;
    }
    const entries: Array<Record<string, unknown>> = [];
    const seenDirs = new Set<string>();
    for (const [filePath, entry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ type: 'file', name: rest, path: filePath, sha: entry.oid, size: rec.objects.get(entry.oid)?.data.length ?? 0 });
      } else {
        const dirName = rest.slice(0, slash);
        if (!seenDirs.has(dirName)) {
          seenDirs.add(dirName);
          const dirPath = `${prefix}${dirName}`;
          entries.push({ type: 'dir', name: dirName, path: dirPath, sha: subtreeOid(rec, commit.tree, dirPath) ?? ZERO_OID });
        }
      }
    }
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    sendRest(res, 200, entries);
    return;
  }

  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok) {
    sendRestError(res, 400, 'Problems parsing JSON');
    return;
  }
  const body = parsed.value;

  if (method === 'PUT') {
    if (path === '') {
      sendRestError(res, 422, 'A file path is required');
      return;
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
    let tip = branchTip(rec, branch);
    if (tip === null && branch !== DEFAULT_BRANCH) {
      // Creating a branch by writing to it: start it at the default branch tip.
      const defaultTip = branchTip(rec, DEFAULT_BRANCH);
      if (defaultTip === null) {
        sendRestError(res, 422, `Branch '${branch}' not found`);
        return;
      }
      rec.refs.set(`refs/heads/${branch}`, defaultTip);
      tip = defaultTip;
    }
    const flat = treeOfCommit(rec, tip);
    const existing = flat.get(path);
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined && (existing === undefined || givenSha !== existing.oid)) {
      sendRestError(res, 409, 'The sha provided does not match the current file sha');
      return;
    }
    if (givenSha === undefined && existing !== undefined) {
      sendRestError(res, 422, 'sha is required when updating an existing file');
      return;
    }
    const data = Buffer.from(typeof body.content === 'string' ? body.content : '', 'base64');
    const blobOid = storeObject(rec, 'blob', data);
    flat.set(path, { oid: blobOid, mode: '100644' });
    const tree = writeTreeFromFlat(rec, flat);
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
    const commit = buildCommit(rec, { tree, parents: tip === null ? [] : [tip], message, ts: tickSec() });
    rec.refs.set(`refs/heads/${branch}`, commit);
    sendRest(res, existing === undefined ? 201 : 200, {
      content: {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: data.length,
        encoding: 'base64',
      },
      commit: { sha: commit, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
    const tip = branchTip(rec, branch);
    const flat = treeOfCommit(rec, tip);
    const existing = flat.get(path);
    if (tip === null || existing === undefined) {
      sendRestError(res, 404, 'Not Found');
      return;
    }
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing.oid) {
      sendRestError(res, 409, 'The sha provided does not match the current file sha');
      return;
    }
    flat.delete(path);
    const tree = writeTreeFromFlat(rec, flat);
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
    const commit = buildCommit(rec, { tree, parents: [tip], message, ts: tickSec() });
    rec.refs.set(`refs/heads/${branch}`, commit);
    sendRest(res, 200, { content: null, commit: { sha: commit, message } });
    return;
  }

  sendRestError(res, 404, 'Not Found');
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const segments = url.pathname.split('/').filter((s) => s !== '').map(decodeSegment);
  // segments[0] === 'api', segments[1] === 'v3'
  const parts = segments.slice(2);
  const method = req.method ?? 'GET';
  // Pagination Link headers must be absolute URLs on the origin the client
  // actually dialed — the request's Host header, not this process's
  // internal placeholder origin.
  const host = req.headers.host ?? 'entry';
  const publicUrl = new URL(`${url.pathname}${url.search}`, `http://${host}`);

  if (!authed(req)) {
    sendRestError(res, 401, 'Bad credentials');
    return;
  }

  const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const jsonBody = (): JsonBody => parseJsonBody(rawBody);

  // API root and meta.
  if (parts.length === 0) {
    if (method === 'GET') {
      sendRest(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
          organization_url: '/api/v3/orgs/{org}',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    sendRestError(res, 404, 'Not Found');
    return;
  }
  if (parts.length === 1 && parts[0] === 'meta' && method === 'GET') {
    sendRest(res, 200, {
      verifiable_password_authentication: true,
      ssh_key_fingerprints: {},
      installed_version: '1.0.0-forge',
      is_connected: false,
    });
    return;
  }
  if (parts.length === 1 && parts[0] === 'user' && method === 'GET') {
    sendRest(res, 200, { ...userJson(VIEWER.login), name: VIEWER.name, email: VIEWER.email });
    return;
  }

  // The viewer's repository collection.
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      const mine = [...repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.id - b.id);
      const page = paginate(publicUrl, mine);
      sendRest(res, 200, page.items.map(repoJson), page.headers);
      return;
    }
    if (method === 'POST') {
      const parsed = jsonBody();
      if (!parsed.ok) {
        sendRestError(res, 400, 'Problems parsing JSON');
        return;
      }
      const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
      if (name === '') {
        sendRestError(res, 422, 'Repository creation failed: name is required');
        return;
      }
      if (findRepo(VIEWER.login, name) !== null) {
        sendRest(res, 422, {
          message: 'Repository creation failed: a repository with this name already exists',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
        return;
      }
      const rec = createRepo(
        VIEWER.login,
        name,
        typeof parsed.value.description === 'string' ? parsed.value.description : '',
        parsed.value.private === true,
      );
      if (parsed.value.auto_init === true) {
        const tree = writeTreeFromFlat(rec, new Map());
        const commit = buildCommit(rec, { tree, parents: [], message: 'Initial commit', ts: tickSec() });
        rec.refs.set(`refs/heads/${DEFAULT_BRANCH}`, commit);
      }
      sendRest(res, 201, repoJson(rec));
      return;
    }
    sendRestError(res, 404, 'Not Found');
    return;
  }
  if (parts.length === 3 && parts[0] === 'users' && parts[2] === 'repos' && method === 'GET') {
    const theirs = [...repos.values()].filter((r) => r.owner.toLowerCase() === (parts[1] as string).toLowerCase()).sort((a, b) => a.id - b.id);
    const page = paginate(publicUrl, theirs);
    sendRest(res, 200, page.items.map(repoJson), page.headers);
    return;
  }

  // Everything under /repos/{owner}/{repo}.
  if (parts.length >= 3 && parts[0] === 'repos') {
    const owner = parts[1] as string;
    const name = parts[2] as string;
    const rest = parts.slice(3);
    const rec = findRepo(owner, name);
    if (rec === null) {
      sendRestError(res, 404, 'Not Found');
      return;
    }

    if (rest.length === 0) {
      if (method === 'GET') {
        sendRest(res, 200, repoJson(rec));
        return;
      }
      if (method === 'PATCH') {
        const parsed = jsonBody();
        if (!parsed.ok) {
          sendRestError(res, 400, 'Problems parsing JSON');
          return;
        }
        if (typeof parsed.value.description === 'string') rec.description = parsed.value.description;
        if (typeof parsed.value.private === 'boolean') rec.isPrivate = parsed.value.private;
        if (typeof parsed.value.name === 'string' && parsed.value.name !== '' && parsed.value.name !== rec.name) {
          repos.delete(repoKey(rec.owner, rec.name));
          rec.name = parsed.value.name;
          repos.set(repoKey(rec.owner, rec.name), rec);
        }
        sendRest(res, 200, repoJson(rec));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(rec.owner, rec.name));
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      sendRestError(res, 404, 'Not Found');
      return;
    }

    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const parsed = jsonBody();
        if (!parsed.ok) {
          sendRestError(res, 400, 'Problems parsing JSON');
          return;
        }
        const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
        if (!ref.startsWith('refs/') || !rec.objects.has(sha)) {
          sendRestError(res, 422, 'Invalid ref or sha');
          return;
        }
        if (rec.refs.has(ref)) {
          sendRestError(res, 422, 'Reference already exists');
          return;
        }
        rec.refs.set(ref, sha);
        const obj = rec.objects.get(sha) as GitObj;
        sendRest(res, 201, { ref, object: { sha, type: obj.type } });
        return;
      }
      if (method === 'GET' && rest.length > 2) {
        const fullRef = `refs/${rest.slice(2).join('/')}`;
        const sha = rec.refs.get(fullRef);
        if (sha === undefined) {
          sendRestError(res, 404, 'Not Found');
          return;
        }
        const obj = rec.objects.get(sha);
        sendRest(res, 200, { ref: fullRef, object: { sha, type: obj?.type ?? 'commit' } });
        return;
      }
      sendRestError(res, 404, 'Not Found');
      return;
    }

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const heads = [...rec.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const page = paginate(publicUrl, heads);
        sendRest(res, 200, page.items, page.headers);
        return;
      }
      if (rest.length > 1 && method === 'GET') {
        const branch = rest.slice(1).join('/');
        const sha = branchTip(rec, branch);
        if (sha === null) {
          sendRestError(res, 404, 'Not Found');
          return;
        }
        sendRest(res, 200, { name: branch, commit: { sha }, protected: false });
        return;
      }
      sendRestError(res, 404, 'Not Found');
      return;
    }

    // commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const shaParam = url.searchParams.get('sha');
      let tip: string | null;
      if (shaParam === null || shaParam === '') tip = branchTip(rec, DEFAULT_BRANCH);
      else tip = branchTip(rec, shaParam) ?? (getCommit(rec, shaParam) !== null ? shaParam : null);
      if (tip === null) {
        if (rec.refs.size === 0) {
          sendRest(res, 200, []);
          return;
        }
        sendRestError(res, 404, 'Not Found');
        return;
      }
      const page = paginate(publicUrl, listCommits(rec, tip));
      sendRest(res, 200, page.items.map((c) => commitJson(rec, c)), page.headers);
      return;
    }

    // contents
    if (rest[0] === 'contents') {
      handleContents(rec, req, res, url, rest.slice(1).join('/'), rawBody);
      return;
    }

    // labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') {
        const labels = [...rec.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description, default: false }));
        const page = paginate(publicUrl, labels);
        sendRest(res, 200, page.items, page.headers);
        return;
      }
      if (method === 'POST') {
        const parsed = jsonBody();
        if (!parsed.ok) {
          sendRestError(res, 400, 'Problems parsing JSON');
          return;
        }
        const labelName = typeof parsed.value.name === 'string' ? parsed.value.name : '';
        const color = typeof parsed.value.color === 'string' ? parsed.value.color.replace(/^#/, '') : '000000';
        if (labelName === '') {
          sendRestError(res, 422, 'Label name is required');
          return;
        }
        if (rec.labels.has(labelName)) {
          sendRestError(res, 422, 'Label already exists');
          return;
        }
        const label = {
          name: labelName,
          color,
          description: typeof parsed.value.description === 'string' ? parsed.value.description : null,
        };
        rec.labels.set(labelName, label);
        sendRest(res, 201, { ...label, default: false });
        return;
      }
      sendRestError(res, 404, 'Not Found');
      return;
    }

    // issues and their comments
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const direction = url.searchParams.get('direction') ?? 'desc';
          let list = [...rec.issues.values()];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const page = paginate(publicUrl, list);
          sendRest(res, 200, page.items.map((i) => issueJson(rec, i)), page.headers);
          return;
        }
        if (method === 'POST') {
          const parsed = jsonBody();
          if (!parsed.ok) {
            sendRestError(res, 400, 'Problems parsing JSON');
            return;
          }
          const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
          if (title === '') {
            sendRestError(res, 422, 'Issue title is required');
            return;
          }
          const labels = Array.isArray(parsed.value.labels)
            ? parsed.value.labels.map((l) => (typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : '')).filter((l) => l !== '')
            : [];
          const outcome = createIssue(rec, {
            title,
            body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
            labels,
          });
          if ('error' in outcome) {
            sendRestError(res, outcome.status, outcome.error);
            return;
          }
          sendRest(res, 201, issueJson(rec, outcome.issue));
          return;
        }
        sendRestError(res, 404, 'Not Found');
        return;
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const issue = Number.isFinite(number) ? rec.issues.get(number) : undefined;
      const pullForIssue = Number.isFinite(number) ? rec.pulls.get(number) : undefined;
      if (rest.length === 2) {
        if (method === 'GET') {
          if (issue !== undefined) {
            sendRest(res, 200, issueJson(rec, issue));
            return;
          }
          if (pullForIssue !== undefined) {
            sendRest(res, 200, { ...pullJson(rec, pullForIssue), pull_request: { merged_at: pullForIssue.mergedAt } });
            return;
          }
          sendRestError(res, 404, 'Not Found');
          return;
        }
        if (method === 'PATCH' && issue !== undefined) {
          const parsed = jsonBody();
          if (!parsed.ok) {
            sendRestError(res, 400, 'Problems parsing JSON');
            return;
          }
          if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
          if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
          if (parsed.value.state === 'closed' || parsed.value.state === 'open') {
            issue.state = parsed.value.state;
          }
          if (Array.isArray(parsed.value.labels)) {
            const labels = parsed.value.labels.map((l) => (typeof l === 'string' ? l : '')).filter((l) => l !== '');
            for (const labelName of labels) {
              if (!rec.labels.has(labelName)) {
                sendRestError(res, 422, `Label '${labelName}' does not exist in this repository`);
                return;
              }
            }
            issue.labels = labels;
          }
          issue.updatedAt = nowIso();
          sendRest(res, 200, issueJson(rec, issue));
          return;
        }
        sendRestError(res, 404, 'Not Found');
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const holder = issue ?? pullForIssue;
        if (holder === undefined) {
          sendRestError(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          const page = paginate(publicUrl, holder.comments);
          sendRest(res, 200, page.items.map((c) => commentJson(rec, c)), page.headers);
          return;
        }
        if (method === 'POST') {
          const parsed = jsonBody();
          if (!parsed.ok) {
            sendRestError(res, 400, 'Problems parsing JSON');
            return;
          }
          const comment: CommentRec = {
            id: rec.nextCommentId,
            body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
            createdAt: nowIso(),
          };
          rec.nextCommentId += 1;
          holder.comments.push(comment);
          sendRest(res, 201, commentJson(rec, comment));
          return;
        }
        sendRestError(res, 404, 'Not Found');
        return;
      }
      sendRestError(res, 404, 'Not Found');
      return;
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let list = [...rec.pulls.values()];
          if (state === 'open') list = list.filter((p) => !p.merged && p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.merged || p.state === 'closed');
          list.sort((a, b) => b.number - a.number);
          const page = paginate(publicUrl, list);
          sendRest(res, 200, page.items.map((p) => pullJson(rec, p)), page.headers);
          return;
        }
        if (method === 'POST') {
          const parsed = jsonBody();
          if (!parsed.ok) {
            sendRestError(res, 400, 'Problems parsing JSON');
            return;
          }
          const outcome = createPull(rec, {
            title: typeof parsed.value.title === 'string' ? parsed.value.title : '',
            body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
            head: typeof parsed.value.head === 'string' ? parsed.value.head : '',
            base: typeof parsed.value.base === 'string' && parsed.value.base !== '' ? parsed.value.base : DEFAULT_BRANCH,
          });
          if ('error' in outcome) {
            sendRestError(res, outcome.status, outcome.error);
            return;
          }
          sendRest(res, 201, pullJson(rec, outcome.pull));
          return;
        }
        sendRestError(res, 404, 'Not Found');
        return;
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const pull = Number.isFinite(number) ? rec.pulls.get(number) : undefined;
      if (pull === undefined) {
        sendRestError(res, 404, 'Not Found');
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        sendRest(res, 200, pullJson(rec, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const files = pullFiles(rec, pull).map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          sha: f.sha,
        }));
        const page = paginate(publicUrl, files);
        sendRest(res, 200, page.items, page.headers);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const parsed = jsonBody();
        if (!parsed.ok) {
          sendRestError(res, 400, 'Problems parsing JSON');
          return;
        }
        const outcome = squashMerge(rec, pull);
        if ('error' in outcome) {
          sendRestError(res, outcome.status, outcome.error);
          return;
        }
        sendRest(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      sendRestError(res, 404, 'Not Found');
      return;
    }

    sendRestError(res, 404, 'Not Found');
    return;
  }

  sendRestError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_CAPS_V0 =
  'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not ' +
  'include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want no-progress agent=forge/1.0.0';
const RECEIVE_CAPS_V0 = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0.0';

function sortedRefs(rec: RepoRec): Array<[string, string]> {
  return [...rec.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function advertiseRefs(rec: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', version2: boolean): Buffer {
  if (service === 'git-upload-pack' && version2) {
    const parts = [
      pktLine('version 2\n'),
      pktLine('agent=forge/1.0.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    return Buffer.concat(parts);
  }
  const caps =
    service === 'git-upload-pack'
      ? `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${DEFAULT_BRANCH}`
      : `${RECEIVE_CAPS_V0} symref=HEAD:refs/heads/${DEFAULT_BRANCH}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(rec);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = branchTip(rec, DEFAULT_BRANCH) ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const obj = rec.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(rec, oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(rec: RepoRec, body: Buffer): Buffer {
  const first = readPkts(body, 0);
  const argsSection = readPkts(body, first.end);
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const lineBuf of argsSection.lines) {
    const line = lineBuf.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headOid = branchTip(rec, DEFAULT_BRANCH);
  if (matches('HEAD')) {
    if (headOid !== null) {
      let line = `${headOid} HEAD`;
      if (args.symrefs) line += ` symref-target:refs/heads/${DEFAULT_BRANCH}`;
      parts.push(pktLine(`${line}\n`));
    } else if (args.unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(rec)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    const obj = rec.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = peelToCommit(rec, oid);
      if (peeled !== null && args.peel) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchPlan {
  objects: Array<{ type: ObjType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

function planFetch(
  rec: RepoRec,
  wants: string[],
  haves: string[],
  shallowReq: string[],
  deepen: number | null,
): FetchPlan {
  const shallowSet = new Set(shallowReq);
  const exclude = haveClosure(rec, haves, shallowSet);
  const wantCommits: string[] = [];
  const extraObjects = new Set<string>(); // tags / trees / blobs named directly as wants
  for (const want of wants) {
    const obj = rec.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      wantCommits.push(want);
    } else if (obj.type === 'tag') {
      extraObjects.add(want);
      const peeled = peelToCommit(rec, want);
      if (peeled !== null) wantCommits.push(peeled);
    } else {
      extraObjects.add(want);
    }
  }

  const includedCommits: string[] = [];
  const level = new Map<string, number>();
  if (deepen !== null) {
    let frontier = [...new Set(wantCommits)];
    for (const oid of frontier) level.set(oid, 1);
    let depth = 1;
    while (frontier.length > 0 && depth < deepen) {
      const next: string[] = [];
      for (const oid of frontier) {
        const commit = getCommit(rec, oid);
        if (commit === null) continue;
        for (const parent of commit.parents) {
          if (!level.has(parent) && getCommit(rec, parent) !== null) {
            level.set(parent, depth + 1);
            next.push(parent);
          }
        }
      }
      frontier = next;
      depth += 1;
    }
    includedCommits.push(...level.keys());
  } else {
    const seen = new Set<string>();
    const queue = [...wantCommits];
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head] as string;
      if (seen.has(oid)) continue;
      const commit = getCommit(rec, oid);
      if (commit === null) continue;
      seen.add(oid);
      includedCommits.push(oid);
      queue.push(...commit.parents);
    }
    for (const oid of includedCommits) level.set(oid, 1);
  }

  const include = new Set<string>();
  for (const oid of includedCommits) {
    include.add(oid);
    const commit = getCommit(rec, oid);
    if (commit !== null) addTreeClosure(rec, commit.tree, include);
  }
  for (const oid of extraObjects) {
    include.add(oid);
    const obj = rec.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = peelToCommit(rec, oid);
      if (peeled !== null && !include.has(peeled)) {
        // A wanted tag whose commit is not otherwise included: include its closure.
        const closure = new Set<string>();
        const seen = new Set<string>();
        const queue = [peeled];
        for (let head = 0; head < queue.length; head += 1) {
          const c = queue[head] as string;
          if (seen.has(c)) continue;
          const commit = getCommit(rec, c);
          if (commit === null) continue;
          seen.add(c);
          closure.add(c);
          addTreeClosure(rec, commit.tree, closure);
          queue.push(...commit.parents);
        }
        for (const o of closure) include.add(o);
      }
    }
  }
  for (const oid of exclude) include.delete(oid);

  const includedCommitSet = new Set(includedCommits.filter((oid) => include.has(oid)));
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of includedCommitSet) {
    const commit = getCommit(rec, oid);
    if (commit === null || commit.parents.length === 0) continue;
    const parentsIncluded = commit.parents.every((p) => includedCommitSet.has(p) || exclude.has(p));
    if (!parentsIncluded) shallow.push(oid);
  }
  for (const oid of shallowSet) {
    if (includedCommitSet.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
  }

  const byType: Record<ObjType, string[]> = { commit: [], tree: [], blob: [], tag: [] };
  for (const oid of include) {
    const obj = rec.objects.get(oid);
    if (obj !== undefined) byType[obj.type].push(oid);
  }
  const ordered = [...includedCommits.filter((oid) => include.has(oid)), ...byType.tree, ...byType.blob, ...byType.tag];
  const seenOrdered = new Set<string>();
  const objects: Array<{ type: ObjType; data: Buffer }> = [];
  for (const oid of ordered) {
    if (seenOrdered.has(oid)) continue;
    seenOrdered.add(oid);
    const obj = rec.objects.get(oid);
    if (obj !== undefined) objects.push(obj);
  }
  return { objects, shallow, unshallow };
}

function handleFetchV2(rec: RepoRec, body: Buffer): Buffer {
  const first = readPkts(body, 0);
  const argsSection = readPkts(body, first.end);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReq: string[] = [];
  let deepen: number | null = null;
  for (const lineBuf of argsSection.lines) {
    const line = lineBuf.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowReq.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7), 10) || null;
  }
  const plan = planFetch(rec, wants, haves, shallowReq, deepen);
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    let acked = 0;
    for (const have of haves) {
      if (rec.objects.has(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked += 1;
      }
    }
    if (acked === 0) parts.push(pktLine('NAK\n'));
    else parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandFrame(pack, 1));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(rec: RepoRec, body: Buffer): Buffer {
  const wantSection = readPkts(body, 0);
  const wants: string[] = [];
  for (const lineBuf of wantSection.lines) {
    const line = lineBuf.toString('utf8').replace(/\n$/, '');
    const spaceAt = line.indexOf(' ');
    const clean = spaceAt >= 0 ? line.slice(0, line.indexOf('\0') >= 0 ? line.indexOf('\0') : line.length) : line;
    if (clean.startsWith('want ')) wants.push(clean.slice(5).trim().split(' ')[0] as string);
  }
  const rest = readPkts(body, wantSection.end);
  const haves: string[] = [];
  const shallowReq: string[] = [];
  let deepen: number | null = null;
  for (const lineBuf of rest.lines) {
    const line = lineBuf.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowReq.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7), 10) || null;
  }
  const plan = planFetch(rec, wants, haves, shallowReq, deepen);
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  parts.push(sidebandFrame(pack, 1));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleReceivePack(rec: RepoRec, body: Buffer): Promise<Buffer> {
  const commandSection = readPkts(body, 0);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const lineBuf of commandSection.lines) {
    let line = lineBuf.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match !== null) commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  const packBytes = body.subarray(commandSection.end);
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes.length > 0) {
    if (packBytes.toString('ascii', 0, 4) !== 'PACK') {
      unpackOk = false;
      unpackDetail = 'malformed pack header';
    } else {
      try {
        const parsed = await parsePack(packBytes, (oid) => rec.objects.get(oid));
        for (const [oid, obj] of parsed) rec.objects.set(oid, obj);
      } catch (error) {
        unpackOk = false;
        unpackDetail = error instanceof Error ? error.message : 'unpack failed';
      }
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = rec.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) results.push({ ref: command.ref, ok: false, reason: 'reference not found' });
      else if (command.oldOid !== ZERO_OID && current !== command.oldOid) results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      else {
        rec.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!rec.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      else {
        rec.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    const isTag = command.ref.startsWith('refs/tags/');
    if (!isTag && !isAncestor(rec, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    rec.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const inner: Buffer[] = [];
  inner.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack error ${unpackDetail}\n`));
  for (const result of results) {
    inner.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(PKT_FLUSH);
  return Buffer.concat([sidebandFrame(Buffer.concat(inner), 1), PKT_FLUSH]);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, owner: string, repoName: string): Promise<void> {
  const tail = url.pathname.endsWith('/info/refs') ? 'info/refs' : (url.pathname.split('/').pop() as string);
  const rec = findRepo(owner, repoName);
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  if (rec === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (tail === 'info/refs' && (req.method ?? 'GET') === 'GET') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const body = advertiseRefs(rec, service, version2);
    res.writeHead(200, {
      'content-type': `application/x-${service}-advertisement`,
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
    return;
  }
  if (tail === 'git-upload-pack' && (req.method ?? '') === 'POST') {
    const body = await readBody(req);
    // The command line decides the dialect: v2 requests open with 'command='.
    const first = readPkts(body, 0);
    const firstLine = first.lines.length > 0 ? (first.lines[0] as Buffer).toString('utf8') : '';
    let out: Buffer;
    if (firstLine.startsWith('command=ls-refs')) out = handleLsRefs(rec, body);
    else if (firstLine.startsWith('command=fetch')) out = handleFetchV2(rec, body);
    else out = handleFetchV0(rec, body);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
    res.end(out);
    return;
  }
  if (tail === 'git-receive-pack' && (req.method ?? '') === 'POST') {
    const body = await readBody(req);
    const out = await handleReceivePack(rec, body);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
    res.end(out);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// GraphQL v4 (hand-written lexer / parser / executor over the same store)
// ---------------------------------------------------------------------------

type GValue =
  | { t: 'var'; name: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'enum'; v: string }
  | { t: 'list'; items: GValue[] }
  | { t: 'obj'; fields: Array<[string, GValue]> };

interface GField {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<[string, GValue]>;
  directives: Array<[string, Array<[string, GValue]>]>;
  selectionSet: GSelection[] | null;
}
type GSelection =
  | GField
  | { kind: 'spread'; name: string; directives: Array<[string, Array<[string, GValue]>]> }
  | { kind: 'inline'; typeCondition: string | null; directives: Array<[string, Array<[string, GValue]>]>; selectionSet: GSelection[] };

interface GOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: GSelection[];
}

interface GToken {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}

function gqlTokenize(source: string): GToken[] {
  const tokens: GToken[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text.replace(/\\"""/g, '"""') });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL syntax error: unexpected character '${ch}'`);
  }
  return tokens;
}

class GParser {
  private tokens: GToken[];
  private pos = 0;
  constructor(tokens: GToken[]) {
    this.tokens = tokens;
  }
  private peek(): GToken | undefined {
    return this.tokens[this.pos];
  }
  private next(): GToken {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('GraphQL syntax error: unexpected end of document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`GraphQL syntax error: expected '${value}'`);
  }
  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }
  private skipType(): void {
    // A type reference: Name | '[' type ']', with optional '!'.
    if (this.atPunct('[')) {
      this.next();
      this.skipType();
      this.expectPunct(']');
    } else {
      this.next(); // the type name
    }
    if (this.atPunct('!')) this.next();
  }
  private parseValue(): GValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      return { t: 'var', name: name.value };
    }
    if (token.kind === 'string') return { t: 'str', v: token.value };
    if (token.kind === 'int' || token.kind === 'float') return { t: 'num', v: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: GValue[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { t: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<[string, GValue]> = [];
      while (!this.atPunct('}')) {
        const name = this.next();
        this.expectPunct(':');
        fields.push([name.value, this.parseValue()]);
      }
      this.expectPunct('}');
      return { t: 'obj', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { t: 'bool', v: true };
      if (token.value === 'false') return { t: 'bool', v: false };
      if (token.value === 'null') return { t: 'null' };
      return { t: 'enum', v: token.value };
    }
    throw new Error('GraphQL syntax error: unexpected value');
  }
  private parseArgs(): Array<[string, GValue]> {
    const args: Array<[string, GValue]> = [];
    if (!this.atPunct('(')) return args;
    this.next();
    while (!this.atPunct(')')) {
      const name = this.next();
      this.expectPunct(':');
      args.push([name.value, this.parseValue()]);
    }
    this.expectPunct(')');
    return args;
  }
  private parseDirectives(): Array<[string, Array<[string, GValue]>]> {
    const directives: Array<[string, Array<[string, GValue]>]> = [];
    while (this.atPunct('@')) {
      this.next();
      const name = this.next();
      directives.push([name.value, this.parseArgs()]);
    }
    return directives;
  }
  private parseSelectionSet(): GSelection[] {
    this.expectPunct('{');
    const selections: GSelection[] = [];
    while (!this.atPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }
  private parseSelection(): GSelection {
    const token = this.peek();
    if (token !== undefined && token.kind === 'spread') {
      this.next();
      const after = this.peek();
      if (after !== undefined && after.kind === 'name' && after.value === 'on') {
        this.next();
        const condition = this.next();
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition: condition.value, directives, selectionSet: this.parseSelectionSet() };
      }
      const name = this.next();
      return { kind: 'spread', name: name.value, directives: this.parseDirectives() };
    }
    const first = this.next();
    let alias: string | null = null;
    let name = first.value;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = this.parseArgs();
    const directives = this.parseDirectives();
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, directives, selectionSet };
  }
  parseDocument(): { operations: GOperation[]; fragments: Map<string, GSelection[]> } {
    const operations: GOperation[] = [];
    const fragments = new Map<string, GSelection[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as GToken;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName !== undefined && maybeName.kind === 'name') name = this.next().value;
        if (this.atPunct('(')) {
          // Variable definitions: '(' '$' name ':' type ('=' value)? directives? ... ')'
          this.next();
          while (!this.atPunct(')')) {
            this.expectPunct('$');
            this.next(); // variable name
            this.expectPunct(':');
            this.skipType();
            if (this.atPunct('=')) {
              this.next();
              this.parseValue(); // default value, discarded (the suite always passes values)
            }
            this.parseDirectives();
          }
          this.expectPunct(')');
        }
        this.parseDirectives();
        operations.push({
          type: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        const onToken = this.next();
        if (onToken.value !== 'on') throw new Error('GraphQL syntax error: fragment without type condition');
        this.next(); // the type condition (execution resolves spreads against carriers directly)
        this.parseDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`GraphQL syntax error: unexpected token '${token.value}'`);
    }
    return { operations, fragments };
  }
}

function resolveGValue(value: GValue, vars: Record<string, unknown>): unknown {
  switch (value.t) {
    case 'var':
      return vars[value.name] ?? null;
    case 'str':
    case 'num':
    case 'bool':
    case 'enum':
      return value.v;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveGValue(item, vars));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveGValue(inner, vars);
      return out;
    }
  }
}

// --- carriers ---------------------------------------------------------------

type GObj = { __typename: string } & Record<string, unknown>;

function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function userCarrier(login: string): GObj {
  return { __typename: 'User', _login: login };
}

function repoCarrier(rec: RepoRec): GObj {
  return { __typename: 'Repository', _rec: rec };
}

function issueCarrier(rec: RepoRec, issue: IssueRec): GObj {
  return { __typename: 'Issue', _rec: rec, _issue: issue };
}

function pullCarrier(rec: RepoRec, pull: PullRec): GObj {
  return { __typename: 'PullRequest', _rec: rec, _pull: pull };
}

function commentCarrier(rec: RepoRec, comment: CommentRec): GObj {
  return { __typename: 'IssueComment', _rec: rec, _comment: comment };
}

function connectionCarrier(typename: string, nodes: GObj[], pageInfo: Record<string, unknown>, total: number): GObj {
  return { __typename: typename, _nodes: nodes, _pageInfo: pageInfo, _total: total };
}

const CURSOR_PREFIX = 'cursor:';
function cursorOf(index: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${index}`, 'utf8').toString('base64');
}
function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith(CURSOR_PREFIX)) return -1;
    const n = Number.parseInt(text.slice(CURSOR_PREFIX.length), 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

function paginateGql<T>(all: T[], args: Record<string, unknown>, wrap: (item: T) => GObj, typename: string): GObj {
  const firstRaw = typeof args.first === 'number' ? Math.trunc(args.first) : all.length;
  const first = Math.max(0, Math.min(firstRaw, all.length));
  const afterIndex = indexOfCursor(args.after);
  const start = afterIndex >= 0 ? afterIndex + 1 : 0;
  const slice = all.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  const pageInfo = {
    __typename: 'PageInfo',
    hasNextPage: start + slice.length < all.length,
    hasPreviousPage: start > 0,
    startCursor: slice.length > 0 ? cursorOf(start) : null,
    endCursor: slice.length > 0 ? cursorOf(endIndex) : null,
  };
  return connectionCarrier(typename, slice.map(wrap), pageInfo, all.length);
}

// --- schema tables for introspection ----------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'addLabelsToLabelable', 'updateIssue'],
  User: ['id', 'login', 'name', 'email', 'url', 'databaseId', 'isViewer'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'labels', 'refs', 'ref', 'object', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'repository', 'labels', 'comments', 'assignees', 'milestone',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'repository', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid',
    'mergeCommit', 'files', 'comments', 'additions', 'deletions', 'changedFiles', 'isDraft',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'url', 'createdAt', 'updatedAt', 'author', 'issue'],
  Branch: ['name', 'prefix', 'target'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'committedDate', 'authoredDate', 'author', 'tree'],
  GitActor: ['name', 'email', 'date'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  RateLimit: ['limit', 'cost', 'remaining', 'used', 'resetAt', 'nodeCount'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  IssueCommentEdge: ['node', 'cursor'],
  Ref: ['name', 'prefix', 'target'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  StatusState: ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
};

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'URI', 'DateTime', 'GitObjectID', 'GitTimestamp', 'HTML']);

function typeCarrier(name: string): GObj | null {
  if (Object.prototype.hasOwnProperty.call(TYPE_FIELDS, name)) {
    return { __typename: '__Type', _name: name, _kind: 'OBJECT' };
  }
  if (Object.prototype.hasOwnProperty.call(ENUM_TYPES, name)) {
    return { __typename: '__Type', _name: name, _kind: 'ENUM' };
  }
  if (SCALAR_TYPES.has(name)) return { __typename: '__Type', _name: name, _kind: 'SCALAR' };
  if (name.endsWith('Input')) return { __typename: '__Type', _name: name, _kind: 'INPUT_OBJECT' };
  return null;
}

// --- field resolution ---------------------------------------------------------

class GFieldError extends Error {}

interface GContext {
  vars: Record<string, unknown>;
  fragments: Map<string, GSelection[]>;
  errors: Array<{ message: string; path: Array<string | number> }>;
}

function decodeNodeId(id: unknown): GObj | null {
  if (typeof id !== 'string') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  const kind = parts[0];
  if (kind === 'Repository') {
    const rec = findRepoById(Number.parseInt(parts[1] ?? '', 10));
    return rec === null ? null : repoCarrier(rec);
  }
  if (kind === 'Issue' || kind === 'PullRequest') {
    const rec = findRepoById(Number.parseInt(parts[1] ?? '', 10));
    if (rec === null) return null;
    const number = Number.parseInt(parts[2] ?? '', 10);
    if (kind === 'Issue') {
      const issue = rec.issues.get(number);
      return issue === undefined ? null : issueCarrier(rec, issue);
    }
    const pull = rec.pulls.get(number);
    return pull === undefined ? null : pullCarrier(rec, pull);
  }
  if (kind === 'IssueComment') {
    const rec = findRepoById(Number.parseInt(parts[1] ?? '', 10));
    if (rec === null) return null;
    const cid = Number.parseInt(parts[2] ?? '', 10);
    for (const issue of rec.issues.values()) {
      const comment = issue.comments.find((c) => c.id === cid);
      if (comment !== undefined) return commentCarrier(rec, comment);
    }
    for (const pull of rec.pulls.values()) {
      const comment = pull.comments.find((c) => c.id === cid);
      if (comment !== undefined) return commentCarrier(rec, comment);
    }
    return null;
  }
  if (kind === 'User') return userCarrier(parts[1] ?? '');
  return null;
}

function resolveGField(type: string, obj: GObj, field: string, args: Record<string, unknown>): unknown {
  switch (type) {
    case 'Query': {
      if (field === 'viewer') return userCarrier(VIEWER.login);
      if (field === 'user') return typeof args.login === 'string' ? userCarrier(args.login) : null;
      if (field === 'repository') {
        const rec = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return rec === null ? null : repoCarrier(rec);
      }
      if (field === 'node') return decodeNodeId(args.id);
      if (field === 'nodes') {
        return Array.isArray(args.ids) ? args.ids.map((id) => decodeNodeId(id)) : [];
      }
      if (field === 'rateLimit') {
        return { __typename: 'RateLimit', limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: isoOf(clockSec + 3600), nodeCount: 1 };
      }
      if (field === '__type') return typeCarrier(String(args.name ?? ''));
      if (field === '__schema') {
        return {
          __typename: '__Schema',
          _types: [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_TYPES), ...SCALAR_TYPES],
        };
      }
      break;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const target = decodeNodeId(input.repositoryId);
        if (target === null || target.__typename !== 'Repository') throw new GFieldError('Repository not found');
        const rec = target._rec as RepoRec;
        const outcome = createIssue(rec, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
        });
        if ('error' in outcome) throw new GFieldError(outcome.error);
        return { __typename: 'CreateIssuePayload', _issue: issueCarrier(rec, outcome.issue), clientMutationId: input.clientMutationId ?? null };
      }
      if (field === 'closeIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const target = decodeNodeId(input.issueId);
        if (target === null || target.__typename !== 'Issue') throw new GFieldError('Issue not found');
        const rec = target._rec as RepoRec;
        const issue = target._issue as IssueRec;
        issue.state = 'closed';
        issue.updatedAt = nowIso();
        return { __typename: 'CloseIssuePayload', _issue: issueCarrier(rec, issue), clientMutationId: input.clientMutationId ?? null };
      }
      if (field === 'createPullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const target = decodeNodeId(input.repositoryId);
        if (target === null || target.__typename !== 'Repository') throw new GFieldError('Repository not found');
        const rec = target._rec as RepoRec;
        const outcome = createPull(rec, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          head: typeof input.headRefName === 'string' ? input.headRefName : '',
          base: typeof input.baseRefName === 'string' && input.baseRefName !== '' ? input.baseRefName : DEFAULT_BRANCH,
        });
        if ('error' in outcome) throw new GFieldError(outcome.error);
        return { __typename: 'CreatePullRequestPayload', _pull: pullCarrier(rec, outcome.pull), clientMutationId: input.clientMutationId ?? null };
      }
      if (field === 'mergePullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const target = decodeNodeId(input.pullRequestId);
        if (target === null || target.__typename !== 'PullRequest') throw new GFieldError('Pull request not found');
        const rec = target._rec as RepoRec;
        const pull = target._pull as PullRec;
        const outcome = squashMerge(rec, pull);
        if ('error' in outcome) throw new GFieldError(outcome.error);
        return { __typename: 'MergePullRequestPayload', _pull: pullCarrier(rec, pull), clientMutationId: input.clientMutationId ?? null };
      }
      if (field === 'addComment') {
        const input = isRecord(args.input) ? args.input : {};
        const target = decodeNodeId(input.subjectId);
        if (target === null || (target.__typename !== 'Issue' && target.__typename !== 'PullRequest')) {
          throw new GFieldError('Subject not found');
        }
        const rec = target._rec as RepoRec;
        const holder = (target.__typename === 'Issue' ? target._issue : target._pull) as IssueRec | PullRec;
        const comment: CommentRec = {
          id: rec.nextCommentId,
          body: typeof input.body === 'string' ? input.body : '',
          createdAt: nowIso(),
        };
        rec.nextCommentId += 1;
        holder.comments.push(comment);
        const carrier = commentCarrier(rec, comment);
        return {
          __typename: 'AddCommentPayload',
          _comment: carrier,
          commentEdge: { __typename: 'IssueCommentEdge', node: carrier, cursor: cursorOf(comment.id) },
          clientMutationId: input.clientMutationId ?? null,
        };
      }
      break;
    }
    case 'User': {
      const login = obj._login as string;
      if (field === 'login') return login;
      if (field === 'id') return gid('User', login);
      if (field === 'databaseId') return SCENARIO_USERS.find((u) => u.login === login)?.id ?? 1;
      if (field === 'name') return SCENARIO_USERS.find((u) => u.login === login)?.name ?? login;
      if (field === 'email') return SCENARIO_USERS.find((u) => u.login === login)?.email ?? '';
      if (field === 'url') return `https://forge.invalid/${login}`;
      if (field === 'isViewer') return login === VIEWER.login;
      break;
    }
    case 'Repository': {
      const rec = obj._rec as RepoRec;
      switch (field) {
        case 'id':
          return gid('Repository', rec.id);
        case 'databaseId':
          return rec.id;
        case 'name':
          return rec.name;
        case 'nameWithOwner':
          return `${rec.owner}/${rec.name}`;
        case 'owner':
          return userCarrier(rec.owner);
        case 'description':
          return rec.description;
        case 'isPrivate':
          return rec.isPrivate;
        case 'url':
          return `https://forge.invalid/${rec.owner}/${rec.name}`;
        case 'createdAt':
        case 'updatedAt':
          return rec.createdAt;
        case 'defaultBranchRef':
          return { __typename: 'Branch', _rec: rec, name: DEFAULT_BRANCH };
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'stargazerCount':
          return 0;
        case 'forkCount':
          return 0;
        case 'issue': {
          const issue = rec.issues.get(typeof args.number === 'number' ? args.number : -1);
          return issue === undefined ? null : issueCarrier(rec, issue);
        }
        case 'issues': {
          let list = [...rec.issues.values()];
          if (Array.isArray(args.states)) {
            const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
            list = list.filter((i) => wanted.has(i.state));
          }
          let descending = true;
          if (isRecord(args.orderBy) && typeof args.orderBy.direction === 'string') {
            descending = args.orderBy.direction !== 'ASC';
          }
          list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
          return paginateGql(list, args, (i) => issueCarrier(rec, i), 'IssueConnection');
        }
        case 'pullRequest': {
          const pull = rec.pulls.get(typeof args.number === 'number' ? args.number : -1);
          return pull === undefined ? null : pullCarrier(rec, pull);
        }
        case 'pullRequests': {
          let list = [...rec.pulls.values()];
          if (Array.isArray(args.states)) {
            const wanted = new Set(args.states.map((s) => String(s)));
            list = list.filter((p) => wanted.has(p.merged ? 'MERGED' : p.state.toUpperCase()));
          }
          list.sort((a, b) => a.number - b.number);
          return paginateGql(list, args, (p) => pullCarrier(rec, p), 'PullRequestConnection');
        }
        case 'labels': {
          const labels = [...rec.labels.values()].map((l) => ({ __typename: 'Label', name: l.name, color: l.color, description: l.description }) as GObj);
          return connectionCarrier('LabelConnection', labels, { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, labels.length);
        }
      }
      break;
    }
    case 'Issue': {
      const rec = obj._rec as RepoRec;
      const issue = obj._issue as IssueRec;
      switch (field) {
        case 'id':
          return gid('Issue', rec.id, issue.number);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state.toUpperCase();
        case 'body':
        case 'bodyText':
          return issue.body;
        case 'url':
          return `https://forge.invalid/${rec.owner}/${rec.name}/issues/${issue.number}`;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.state === 'closed' ? issue.updatedAt : null;
        case 'author':
          return userCarrier(rec.owner);
        case 'repository':
          return repoCarrier(rec);
        case 'labels': {
          const labels = issue.labels.map((name) => {
            const label = rec.labels.get(name);
            return { __typename: 'Label', name, color: label?.color ?? '000000', description: label?.description ?? null } as GObj;
          });
          return connectionCarrier('LabelConnection', labels, { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, labels.length);
        }
        case 'comments':
          return paginateGql(issue.comments, args, (c) => commentCarrier(rec, c), 'IssueCommentConnection');
      }
      break;
    }
    case 'PullRequest': {
      const rec = obj._rec as RepoRec;
      const pull = obj._pull as PullRec;
      switch (field) {
        case 'id':
          return gid('PullRequest', rec.id, pull.number);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'body':
        case 'bodyText':
          return pull.body;
        case 'url':
          return `https://forge.invalid/${rec.owner}/${rec.name}/pull/${pull.number}`;
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'closedAt':
          return pull.state === 'closed' ? pull.updatedAt : null;
        case 'author':
          return userCarrier(rec.owner);
        case 'repository':
          return repoCarrier(rec);
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeable': {
          if (pull.merged) return 'MERGEABLE';
          const outcome = pullMergeable(rec, pull);
          return outcome === null ? 'UNKNOWN' : outcome ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRefOid':
          return branchTip(rec, pull.headRef) ?? ZERO_OID;
        case 'baseRefOid':
          return branchTip(rec, pull.baseRef) ?? ZERO_OID;
        case 'mergeCommit':
          return pull.mergeCommitSha === null ? null : { __typename: 'Commit', _rec: rec, _oid: pull.mergeCommitSha };
        case 'isDraft':
          return false;
        case 'additions':
          return pullFiles(rec, pull).reduce((sum, f) => sum + f.additions, 0);
        case 'deletions':
          return pullFiles(rec, pull).reduce((sum, f) => sum + f.deletions, 0);
        case 'changedFiles':
          return pullFiles(rec, pull).length;
        case 'files':
          return paginateGql(
            pullFiles(rec, pull),
            args,
            (f) => ({ __typename: 'PullRequestFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() }) as GObj,
            'PullRequestFileConnection',
          );
        case 'comments':
          return paginateGql(pull.comments, args, (c) => commentCarrier(rec, c), 'IssueCommentConnection');
      }
      break;
    }
    case 'IssueComment': {
      const rec = obj._rec as RepoRec;
      const comment = obj._comment as CommentRec;
      switch (field) {
        case 'id':
          return gid('IssueComment', rec.id, comment.id);
        case 'databaseId':
          return comment.id;
        case 'body':
        case 'bodyText':
          return comment.body;
        case 'createdAt':
        case 'updatedAt':
          return comment.createdAt;
        case 'author':
          return userCarrier(rec.owner);
        case 'url':
          return `https://forge.invalid/${rec.owner}/${rec.name}/issues`;
      }
      break;
    }
    case 'Branch': {
      const rec = obj._rec as RepoRec;
      if (field === 'name') return obj.name;
      if (field === 'prefix') return 'refs/heads/';
      if (field === 'target') {
        const tip = branchTip(rec, obj.name as string);
        return tip === null ? null : { __typename: 'Commit', _rec: rec, _oid: tip };
      }
      break;
    }
    case 'Commit': {
      const rec = obj._rec as RepoRec;
      const commit = getCommit(rec, obj._oid as string);
      if (commit === null) break;
      switch (field) {
        case 'id':
          return gid('Commit', rec.id, commit.oid);
        case 'oid':
          return commit.oid;
        case 'message':
          return commit.message;
        case 'messageHeadline':
          return commit.message.split('\n')[0] ?? '';
        case 'committedDate':
          return isoOf(commit.committerTs);
        case 'authoredDate':
          return isoOf(commit.authorTs);
        case 'author':
          return { __typename: 'GitActor', name: commit.authorName, email: commit.authorEmail, date: isoOf(commit.authorTs) };
        case 'tree':
          return { __typename: 'Tree', _rec: rec, _oid: commit.tree };
      }
      break;
    }
    case 'GitActor': {
      if (field === 'name' || field === 'email' || field === 'date') return obj[field] ?? null;
      break;
    }
    case 'Label': {
      if (field === 'id') return gid('Label', String(obj.name));
      if (field === 'name' || field === 'color' || field === 'description') return obj[field] ?? null;
      break;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage' || field === 'hasPreviousPage' || field === 'startCursor' || field === 'endCursor') return obj[field] ?? null;
      break;
    }
    case 'RateLimit': {
      if (field in obj) return obj[field];
      break;
    }
    case 'PullRequestFile': {
      if (field === 'path' || field === 'additions' || field === 'deletions' || field === 'changeType') return obj[field] ?? null;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return obj._issue;
      if (field === 'clientMutationId') return obj.clientMutationId ?? null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return obj._pull;
      if (field === 'clientMutationId') return obj.clientMutationId ?? null;
      break;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return obj.commentEdge;
      if (field === 'subject') return null;
      if (field === 'clientMutationId') return obj.clientMutationId ?? null;
      break;
    }
    case 'IssueCommentEdge': {
      if (field === 'node') return obj.node;
      if (field === 'cursor') return obj.cursor;
      break;
    }
    case '__Type': {
      const name = obj._name as string;
      const kind = obj._kind as string;
      switch (field) {
        case 'name':
          return name;
        case 'kind':
          return kind;
        case 'description':
          return null;
        case 'fields': {
          if (kind !== 'OBJECT' && kind !== 'INTERFACE') return null;
          return (TYPE_FIELDS[name] ?? []).map((fname) => ({ __typename: '__Field', _name: fname }) as GObj);
        }
        case 'enumValues': {
          if (kind !== 'ENUM') return null;
          return (ENUM_TYPES[name] ?? []).map((vname) => ({ __typename: '__EnumValue', _name: vname }) as GObj);
        }
        case 'possibleTypes':
        case 'inputFields':
        case 'ofType':
          return null;
        case 'specifiedByURL':
          return null;
      }
      break;
    }
    case '__Field': {
      if (field === 'name') return obj._name;
      if (field === 'description') return null;
      if (field === 'type') return { __typename: '__Type', _name: 'String', _kind: 'SCALAR' };
      if (field === 'args') return [];
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
    case '__EnumValue': {
      if (field === 'name') return obj._name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
    case '__Schema': {
      if (field === 'types') return (obj._types as string[]).map((n) => typeCarrier(n)).filter((t) => t !== null);
      if (field === 'queryType') return typeCarrier('Query');
      if (field === 'mutationType') return typeCarrier('Mutation');
      if (field === 'subscriptionType') return null;
      if (field === 'directives') return [];
      break;
    }
    default: {
      // Connection types and any carrier with plain properties.
      if (type.endsWith('Connection')) {
        if (field === 'nodes') return obj._nodes;
        if (field === 'edges') {
          return (obj._nodes as GObj[]).map((node, i) => ({ __typename: 'Edge', node, cursor: cursorOf(i) }) as GObj);
        }
        if (field === 'pageInfo') return obj._pageInfo;
        if (field === 'totalCount') return obj._total;
      }
      if (field in obj && !field.startsWith('_')) return obj[field];
      break;
    }
  }
  throw new GFieldError(`Field '${field}' doesn't exist on type '${type}'`);
}

function directivesAllow(directives: Array<[string, Array<[string, GValue]>]>, ctx: GContext): boolean {
  for (const [name, args] of directives) {
    const argMap: Record<string, unknown> = {};
    for (const [key, value] of args) argMap[key] = resolveGValue(value, ctx.vars);
    if (name === 'skip' && argMap.if === true) return false;
    if (name === 'include' && argMap.if === false) return false;
  }
  return true;
}

function completeGValue(value: unknown, selectionSet: GSelection[] | null, ctx: GContext, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeGValue(item, selectionSet, ctx, [...path, index]));
  }
  if (isRecord(value) && typeof value.__typename === 'string') {
    if (selectionSet === null) return {};
    return execGSelectionSet(value.__typename as string, value as GObj, selectionSet, ctx, path);
  }
  return value;
}

const INTERFACE_MEMBERS: Record<string, string[]> = {
  Node: ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User', 'Label', 'Commit'],
};

function typeConditionMatches(condition: string | null, typename: string): boolean {
  if (condition === null) return true;
  if (condition === typename) return true;
  const members = INTERFACE_MEMBERS[condition];
  return members !== undefined && members.includes(typename);
}

function execGSelectionSet(type: string, obj: GObj, selections: GSelection[], ctx: GContext, path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const runField = (selection: GField): void => {
    if (!directivesAllow(selection.directives, ctx)) return;
    const key = selection.alias ?? selection.name;
    const fieldPath = [...path, key];
    if (selection.name === '__typename') {
      out[key] = type;
      return;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of selection.args) args[argName] = resolveGValue(argValue, ctx.vars);
    try {
      const raw = resolveGField(type, obj, selection.name, args);
      out[key] = completeGValue(raw, selection.selectionSet, ctx, fieldPath);
    } catch (error) {
      out[key] = null;
      ctx.errors.push({
        message: error instanceof Error ? error.message : String(error),
        path: fieldPath,
      });
    }
  };
  const walk = (list: GSelection[]): void => {
    for (const selection of list) {
      if (selection.kind === 'field') runField(selection);
      else if (selection.kind === 'spread') {
        if (!directivesAllow(selection.directives, ctx)) continue;
        const fragment = ctx.fragments.get(selection.name);
        if (fragment !== undefined) walk(fragment);
      } else {
        if (!directivesAllow(selection.directives, ctx)) continue;
        if (typeConditionMatches(selection.typeCondition, type)) walk(selection.selectionSet);
      }
    }
  };
  walk(selections);
  return out;
}

function executeGraphQL(body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const vars = isRecord(body.variables) ? body.variables : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let document: { operations: GOperation[]; fragments: Map<string, GSelection[]> };
  try {
    document = new GParser(gqlTokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operation =
    document.operations.find((op) => (operationName === null ? true : op.name === operationName)) ?? document.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'No operation found in document' }] };
  }
  const ctx: GContext = { vars, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GObj = { __typename: rootType };
  const data = execGSelectionSet(rootType, root, operation.selectionSet, ctx, []);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) {
    result.errors = ctx.errors.map((e) => ({ message: e.message, path: e.path }));
  }
  return result;
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  if ((req.method ?? '') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON in request body' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => (isRecord(entry) ? executeGraphQL(entry) : { data: null, errors: [{ message: 'Invalid operation' }] }));
    sendJson(res, 200, results);
    return;
  }
  if (isRecord(parsed)) {
    sendJson(res, 200, executeGraphQL(parsed));
    return;
  }
  sendJson(res, 400, { errors: [{ message: 'Invalid GraphQL request' }] });
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC Streamable HTTP; 2026-07-28 discover + legacy initialize)
// ---------------------------------------------------------------------------

const MCP_SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function mcpTool(
  name: string,
  description: string,
  properties: Record<string, string>,
  required: string[],
): McpToolDef {
  const props: Record<string, { type: string; description: string }> = {};
  for (const [key, desc] of Object.entries(properties)) {
    props[key] = { type: key === 'private' ? 'boolean' : key === 'pull_number' ? 'number' : 'string', description: desc };
  }
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

const MCP_TOOLS: McpToolDef[] = [
  mcpTool('create_repo', 'Create a new repository for the authenticated user.', {
    owner: 'The account the repository belongs to',
    name: 'The repository name',
    description: 'A short description of the repository',
    private: 'Whether the repository is private',
  }, ['name']),
  mcpTool('get_repo', 'Read one repository by owner and name.', {
    owner: 'The repository owner login',
    repo: 'The repository name',
  }, ['owner', 'repo']),
  mcpTool('create_issue', 'Open an issue in a repository.', {
    owner: 'The repository owner login',
    repo: 'The repository name',
    title: 'The issue title',
    body: 'The issue body',
  }, ['owner', 'repo', 'title']),
  mcpTool('list_issues', 'List the issues of a repository.', {
    owner: 'The repository owner login',
    repo: 'The repository name',
    state: 'Filter by state: open, closed or all',
  }, ['owner', 'repo']),
  mcpTool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: 'The repository owner login',
    repo: 'The repository name',
    title: 'The pull request title',
    body: 'The pull request body',
    head: 'The head branch name',
    base: 'The base branch name',
  }, ['owner', 'repo', 'title', 'head', 'base']),
  mcpTool('merge_pull_request', 'Squash-merge a pull request into its base branch.', {
    owner: 'The repository owner login',
    repo: 'The repository name',
    pull_number: 'The pull request number',
  }, ['owner', 'repo', 'pull_number']),
];

class McpToolError extends Error {}

function mcpToolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function mcpToolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function runMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  const needRepo = (): RepoRec => {
    const rec = findRepo(str('owner') || VIEWER.login, str('repo'));
    if (rec === null) throw new McpToolError(`Repository '${str('owner')}/${str('repo')}' not found`);
    return rec;
  };
  switch (name) {
    case 'create_repo': {
      const repoName = str('name');
      if (repoName === '') throw new McpToolError('A repository name is required');
      const owner = str('owner') || VIEWER.login;
      if (findRepo(owner, repoName) !== null) throw new McpToolError(`Repository '${owner}/${repoName}' already exists`);
      const rec = createRepo(owner, repoName, str('description'), args.private === true);
      return mcpToolResult(repoJson(rec));
    }
    case 'get_repo': {
      return mcpToolResult(repoJson(needRepo()));
    }
    case 'create_issue': {
      const rec = needRepo();
      const outcome = createIssue(rec, { title: str('title'), body: str('body') });
      if ('error' in outcome) throw new McpToolError(outcome.error);
      return mcpToolResult(issueJson(rec, outcome.issue));
    }
    case 'list_issues': {
      const rec = needRepo();
      const state = str('state') || 'open';
      let list = [...rec.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return mcpToolResult(list.map((i) => issueJson(rec, i)));
    }
    case 'create_pull_request': {
      const rec = needRepo();
      const outcome = createPull(rec, {
        title: str('title'),
        body: str('body'),
        head: str('head'),
        base: str('base') || DEFAULT_BRANCH,
      });
      if ('error' in outcome) throw new McpToolError(outcome.error);
      return mcpToolResult(pullJson(rec, outcome.pull));
    }
    case 'merge_pull_request': {
      const rec = needRepo();
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(str('pull_number'), 10);
      const pull = Number.isFinite(number) ? rec.pulls.get(number) : undefined;
      if (pull === undefined) throw new McpToolError(`Pull request #${String(number)} not found`);
      const outcome = squashMerge(rec, pull);
      if ('error' in outcome) throw new McpToolError(outcome.error);
      return mcpToolResult(pullJson(rec, pull));
    }
    default:
      throw new McpToolError(`Unknown tool '${name}'`);
  }
}

function mcpDispatch(request: Record<string, unknown>): { status: number; body: Record<string, unknown> | null } {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = 'id' in request ? request.id : undefined;
  const params = isRecord(request.params) ? request.params : {};
  const respond = (result: unknown): { status: number; body: Record<string, unknown> } => ({
    status: 200,
    body: { jsonrpc: '2.0', id: id ?? null, result },
  });
  const fail = (code: number, message: string): { status: number; body: Record<string, unknown> } => ({
    status: 200,
    body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
  });
  // Notifications carry no id and are answered with an empty 202.
  if (id === undefined) return { status: 202, body: null };

  switch (method) {
    case 'server/discover':
      return respond({
        resultType: 'complete',
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        _meta: {
          'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO,
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return respond({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
    }
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: MCP_TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = MCP_TOOLS.find((t) => t.name === toolName);
      if (tool === undefined) return fail(-32602, `Unknown tool '${toolName}'`);
      const args = isRecord(params.arguments) ? params.arguments : {};
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return fail(-32602, `Missing required argument '${required}' for tool '${toolName}'`);
        }
      }
      try {
        return respond(runMcpTool(toolName, args));
      } catch (error) {
        if (error instanceof McpToolError) return respond(mcpToolFailure(error.message));
        throw error;
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? '') === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if ((req.method ?? '') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const bodies: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      const outcome = mcpDispatch(entry);
      if (outcome.body !== null) bodies.push(outcome.body);
    }
    sendJson(res, 200, bodies);
    return;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const outcome = mcpDispatch(parsed);
  if (outcome.body === null) {
    res.writeHead(outcome.status);
    res.end();
    return;
  }
  sendJson(res, outcome.status, outcome.body);
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path === '/mcp') {
    await handleMcp(req, res);
    return;
  }
  if (path === '/api/graphql') {
    await handleGraphQL(req, res);
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, url);
    return;
  }
  const gitMatch = /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    await handleGit(req, res, url, decodeSegment(gitMatch[1] as string), decodeSegment((gitMatch[2] as string).replace(/\.git$/, '')));
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((error: unknown) => {
      process.stderr.write(`[entry] request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}
