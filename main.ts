// Entrypoint for the GitHub core clone.
//
// This file owns only the process lifecycle that ties the forge in app.ts to
// the make.fun trial environment; all request handling lives behind
// createApp(). The sequence is dictated by the environment's wire contract:
//
//   * The environment publishes its origin in MAKEFUN_ENV_URL. With no origin
//     there is nobody to register with, so the process refuses to start.
//   * The forge binds an ephemeral TCP port (listen(0)). Port 8080 belongs to
//     the environment itself and is never requested.
//   * The bound port is announced with POST /register. The environment takes
//     the caller's address plus this port as the entry's base URL. Only the
//     first registration counts: a 409 means another process already claimed
//     the slot, which is accepted and changes nothing here.
//   * GET /done is polled until it reports {"done": true}. The environment
//     answers immediately with done:false while the suite runs, so polling is
//     a loop of short requests, and no failure along the way may end the
//     process early — only the environment ends a trial.
//   * Once done, the server closes and the process exits 0.

import type { Server } from 'node:http';
import { createApp } from './app.ts';

/** Per-request ceiling for calls to the environment, in milliseconds. */
const ENV_CALL_TIMEOUT_MS = 30_000;
/** Retry waits grow from this floor, doubling up to the cap below. */
const RETRY_FLOOR_MS = 250;
const RETRY_CAP_MS = 2_000;

/** The environment's origin with any trailing slashes removed, or '' when unset. */
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined) return '';
  return raw.replace(/\/+$/, '');
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Delay before retry number `failures` (0-based): doubling, capped, jitter-free. */
function retryWait(failures: number): number {
  const grown = RETRY_FLOOR_MS * 2 ** Math.min(failures, 8);
  return Math.min(RETRY_CAP_MS, grown);
}

/**
 * Tell the environment which port the forge bound. Success and 409 (slot
 * already claimed by an earlier register) both end the loop normally. A 400
 * or 405 is a contract violation by this process and is fatal. Anything else
 * — a connection refused while the environment starts, a timeout, an
 * unexpected status — is retried forever with backoff.
 */
async function announcePort(origin: string, port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let fatal: Error | null = null;
    try {
      const response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ENV_CALL_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        fatal = new Error(`register refused with HTTP ${response.status}: ${await response.text()}`);
      } else {
        await response.text(); // drain so the connection can be reused
      }
    } catch (error) {
      // Network-level failure: the environment may not be up yet. Retry.
      if (error instanceof Error && error.message.startsWith('register refused')) throw error;
    }
    if (fatal !== null) throw fatal;
    await pause(retryWait(failures));
  }
}

/**
 * Poll the environment until it declares the trial finished. Every outcome
 * other than a parsed {"done": true} — HTTP errors, malformed bodies,
 * timeouts — simply schedules the next poll.
 */
async function waitUntilDone(origin: string): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(ENV_CALL_TIMEOUT_MS),
      });
      if (response.ok) {
        const body: unknown = await response.json();
        if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) {
          return;
        }
      }
    } catch {
      // Not reachable or not parseable yet: the trial is not over.
    }
    await pause(retryWait(failures));
  }
}

/** Start listening on an ephemeral port and resolve with the chosen port. */
function bindEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server bound a non-TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

/** The whole run: bind, announce, wait for the environment, shut down. */
async function run(origin: string): Promise<void> {
  const server = createApp();
  const port = await bindEphemeral(server);
  process.stdout.write(`[entry] forge listening on ephemeral port ${port}\n`);
  await announcePort(origin, port);
  process.stdout.write('[entry] registered with the environment; awaiting done\n');
  await waitUntilDone(origin);
  server.close();
  process.stdout.write('[entry] environment reports done; exiting\n');
}

const origin = envOrigin();
if (origin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no environment to register with\n');
  process.exit(1);
}

try {
  await run(origin);
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[entry] fatal: ${message}\n`);
  process.exit(1);
}
