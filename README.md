# github-core-clone-01 — a GitHub-compatible git forge

A single-process implementation of the GitHub Core Clone 01 surface, written
in TypeScript on the Node.js standard library alone: no git binary, no
packages, no external services. `main.ts` is the harness lifecycle (bind an
ephemeral port, register with `$MAKEFUN_ENV_URL`, poll `/done`, exit 0);
`app.ts` is the server.

## What it implements

- **Git smart HTTP** — protocol v2 `ls-refs`/`fetch` (with shallow and
  deepen semantics, acknowledgments and shallow-info sections), the v0
  advertisement and fetch framing as a fallback, and `git-receive-pack`
  with `report-status`, `side-band-64k`, `delete-refs` and
  fast-forward-only ref updates. Packfiles are generated and parsed in
  process, including OFS/REF delta resolution and thin-pack fixup against
  the store.
- **REST v3** under `/api/v3` — repository CRUD, contents reads/writes with
  sha checks, git refs and branches, commit listing, labels, issues and
  comments, and pull requests with file diffs and squash merges computed
  as three-way merges over tree objects. Every reply is JSON with an
  `X-GitHub-Request-Id`; list endpoints paginate with `Link` headers.
- **GraphQL v4** at `/api/graphql` — a hand-written lexer, parser and
  executor: repository/issue/pull-request queries, connections with cursor
  pagination, the `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations, batched operations, and
  introspection for the checked types.
- **MCP** at `/mcp` — JSON-RPC over Streamable HTTP speaking both the
  2026-07-28 revision (`server/discover`) and the legacy `initialize`
  handshake, with six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) acting on
  the same store as REST.

State is in-memory and deterministic: object ids are SHA-1 content
addresses, resource ids come from sequential counters, and timestamps come
from a logical clock — a live trial and its replay observe the same bytes.

## Run it

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must name the harness env; `MAKEFUN_SHOP_TOKEN` is the
bearer token the suite presents (requests without it are answered 401).
