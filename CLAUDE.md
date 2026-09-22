# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

9Router (`9router-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts live in this one repo:
- The **dashboard + gateway** (root `package.json`, `9router-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, published to npm as `9router`) — a separate package that installs/starts the server and manages the tray. It has its own `package.json`, version, and build.

The code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (the provider-agnostic routing/translation engine), `cli/` (the launcher package), and `tests/`.

## Commands

Dashboard/gateway (run from repo root):
```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev   # dev (webpack, port 20127 by default via next dev)
npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start           # production
```
- Bun variants: `npm run dev:bun` / `build:bun` / `start:bun`.
- Default runtime port is **20128** (dashboard at `/dashboard`, API at `/v1`).
- Lint: `npx eslint .` (config `eslint.config.mjs`, extends `eslint-config-next`).

CLI package (`cli/`):
```bash
npm run cli:pack       # build + npm pack from root
cd cli && npm run dev  # nodemon watch
```

Tests (vitest, in `tests/`, an **independent** ESM package — not wired into root `npm test`):
```bash
npm install                             # ROOT deps first — tests import from src/ which needs `open`, `undici`, etc.
cd tests && npm install                 # then tests' own deps (vitest) → tests/node_modules (allowed by tests/.gitignore)
npx vitest run                          # all tests; auto-discovers tests/vitest.config.js
npx vitest run unit/capabilities.test.js   # single file (path relative to tests/)
```
> The committed `tests/package.json` `test` script hardcodes Unix paths (`NODE_PATH=/tmp/node_modules …`) — a shared-install workaround from upstream. On Windows (or anywhere), ignore it and use the `npx vitest` form above; `vitest.config.js` resolves the `open-sse`/`@/` aliases from the repo root regardless of where vitest lives.
>
> **The suite is expected to be fully green on an offline checkout.** Measured on this tree (v0.5.85-enhanced.1): **3990 pass, 0 fail, 12 expected-fail (the `it.fails` bug-exposure convention, see `tests/translator/AGENTS.md` §6), 79 skip** across 392 files. Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run — its rule is "a failure NOT listed in `known-fails.txt` is a regression", and that list is currently **empty** (the 39 former expected reds were fixed — see the file header and CHANGELOG):
> - `unit/cursor-agent-proto.test.js` passes against the **upstream** AgentService (agent.v1) implementation adopted in v0.5.85 (`c933eefc`): codecs in `open-sse/utils/cursorProtobuf.js` (`encodeAgentValue`/`decodeAgentValue`, `encodeMcpToolDefinition`, `encodeMcpTools`, `decodeMcpArgs`, `encodeMcpResult*`), tool loop wired in `open-sse/executors/cursor.js` via `isAgentCapableRequest`. The fork's parallel codec (`4ed28c79`) was dropped in favor of it — both files match upstream exactly, so take upstream's side on future conflicts there.
> - The 4 Command Code assertion updates follow upstream `13b468b8`/`092c84ea`: image blocks now carry both `mimeType` and `mediaType`, and mid-stream errors throw a readable `Error` instead of emitting a chunk.
> - `unit/embeddings.cloud.test.js` self-skips while `cloud/` worker sources are absent from this repo (it used to fail to COLLECT, invisibly to the gate).
> - **The 79 skips** are `tests/translator/real/**` and `*.real.test.js` making live provider calls (they need credentials) plus the 23 cloud-embeddings tests.
- Regression baselines: `tests/__baseline__/verify-*.mjs` compare against committed snapshots (providers, aliases, OAuth URLs). Run these after touching provider registry / alias logic.

## Architecture

Two authoritative docs already exist — read them before working in these areas rather than re-deriving:
- `docs/ARCHITECTURE.md` — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model.
- `open-sse/AGENTS.md` — the routing/translation engine's own conventions and "how to add a provider/executor/translator". **Read this before editing anything under `open-sse/`.**

### Request flow (the thing to understand first)
`src/app/api/v1/*` route (Next rewrite maps `/v1/*` → `/api/v1/*` in `next.config.mjs`)
→ `src/sse/handlers/chat.js` (parse, combo expansion, account-selection loop)
→ `open-sse/handlers/chatCore.js` (detect source format, translate request, dispatch to executor, retry/refresh, stream setup)
→ `open-sse/executors/*` (per-provider upstream call; `default.js` handles any OpenAI-compatible provider)
→ `open-sse/translator/*` (client format ↔ provider format)
→ SSE back to client.

`src/sse/` is the app-side entry glue; `open-sse/` is the provider-agnostic engine (also usable standalone). Cross that boundary consciously.

### Translator engine (`open-sse/translator/`)
- Pivots through **OpenAI as the intermediate format**. A translator registered on an exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop. Prefer a direct route for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators **self-register** via `register(from, to, reqFn, resFn)` as an import side effect — a new translator file MUST be imported in `open-sse/translator/index.js` or it never runs.
- Never hardcode role/block/model strings — use `open-sse/translator/schema/` and `open-sse/config/` constants. Config-driven and DRY is enforced by convention here.

### Provider registry (`open-sse/providers/registry/*`)
- One file per provider. `providers/registry/index.js` is an **auto-generated** static import list — regenerate it with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, don't hand-edit.
- Add a provider: copy `providers/REGISTRY_TEMPLATE.js`, add models to `config/providerModels.js`. Only add an executor for non-OpenAI-compatible upstreams.

### Persistence — IMPORTANT (ARCHITECTURE.md is stale here)
State is **no longer `db.json`**. It's a SQLite layer under `src/lib/db/` with an adapter fallback chain (`driver.js`): `bun:sqlite` → `better-sqlite3` (optional native dep) → `node:sqlite` (Node ≥22.5) → `sql.js` (pure-JS fallback, always works). `better-sqlite3` is deliberately in `optionalDependencies` so install never fails without build tools.
- `src/lib/localDb.js` is a **backward-compat shim** re-exporting `src/lib/db/index.js`. New code should import from `@/lib/db/index.js`; per-entity logic lives in `src/lib/db/repos/*`. Schema/migrations in `src/lib/db/migrations/`.
- DB file location resolves via `src/lib/db/paths.js` (`DATA_DIR`, else `~/.9router/`).
- Usage/logs (`src/lib/usageDb.js`, `usage.json` + `log.txt`) still live under `~/.9router` and do **not** follow `DATA_DIR`.

### RTK token saver (`open-sse/rtk/`)
Pre-translate hooks that compress `tool_result` content in-place to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of them. Skips `is_error`/`status:"error"` results to preserve traces.

## Conventions & gotchas

- Plain JavaScript (ESM), no TypeScript. `@/*` path alias → `src/*` (`jsconfig.json`).
- `custom-server.js` wraps the Next standalone server to derive client IP from the TCP socket and strip attacker-controlled `X-Forwarded-For` — trusting forwarding headers only from a loopback reverse proxy. Preserve this when touching request/IP/rate-limit code.
- Security-sensitive env: `JWT_SECRET` (session cookie), `INITIAL_PASSWORD` (default `123456` — must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Full env contract in `.env.example` and ARCHITECTURE.md's env matrix.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — they're handled inside their own executor, not the translator.
- Versioning: root and `cli/` are versioned independently; changes are logged in `CHANGELOG.md`. Commit style is Conventional Commits (`fix(translator): …`, `feat(...)`).

## Secret hygiene — hard rules (never leak again)

Incident this section exists for: commit `61b84a78` bundled `9router-0.5.69.tgz` into git history. The pack embedded build-HOME state — `jwt-secret` (the HS256 key that signs dashboard admin sessions), `machine-id`, and `db/data.sqlite`. It was untracked in `8e0617a5`, but the blob stays **public forever** in this public fork's history. (Verified: the sqlite came out empty of credentials, and the leaked secret is no longer in use on any live instance — but the rotation/purge cost was real.)

1. **Never stage archives, build artifacts, or state.** `*.tgz`/`*.tar`/`*.zip`, `cli/.build-home/`, `.next*/`, `*.sqlite*`/`*.db`, `jwt-secret`, `machine-id`, `.env*` (except `.env.example`), `usage.json`, `log.txt`, token/session caches. The `*.tgz` ignore rule exists precisely because `build-cli` historically embedded HOME state into packs — treat any tarball or binary blob as guilty until inspected (`tar tz` it before `git add`; if you truly must commit one, that decision goes in the commit message with justification).
2. **Run the guard before committing** — `npm install` installs it as `.git/hooks/pre-commit` (`prepare` → `scripts/install-hooks.mjs`; it leaves a foreign pre-commit hook alone), and `.github/workflows/secret-scan.yml` re-runs it with `--range` on every push/PR as the server-side backstop:
   ```bash
   node scripts/check-no-secrets.mjs            # scans staged additions (pre-commit)
   node scripts/check-no-secrets.mjs --range A..B   # scans additions between commits (CI)
   node scripts/check-no-secrets.mjs <paths>    # scan before staging
   ```
   It blocks secret-shaped content (provider tokens, private keys, JWTs, AWS/GitHub/Slack/GitLab patterns, hardcoded values for `JWT_SECRET`/`API_KEY_SECRET`/`MACHINE_ID_SALT`) and forbidden filenames. There is **no bypass flag by design**: a false positive is fixed by extending the allowlist in `scripts/check-no-secrets.mjs` (or a `secret-scan:allow` comment on the line) **in the same commit**, so the judgment call is auditable.
3. **Untracking a leaked secret is not a fix.** Once pushed, it is public forever: rotate the credential first, then purge history (`git filter-repo` + force-push; GitHub Support clears cached views/dangling objects). Prevention is the only cheap option.
4. **Real credentials never enter code, tests, fixtures, docs, or commit messages.** Fixtures use obviously-fake values (`glpat-xxx…`, one-char key bodies). When adding OAuth/credential flows, derive test data from the fake-value convention, never from a real capture.
5. **Public-by-design identifiers are not secrets — leave them alone.** Firebase Web API keys (e.g. the upstream Windsurf `AIzaSy…` in `src/lib/oauth/constants/oauth.js`) are client identifiers restricted in the Firebase console; they are allowlisted in the guard. Do not "clean" them, and do not use them as precedent for keeping anything that actually authenticates.
6. **`.env.example` is the only env file that may be tracked**, and it must contain placeholders only — never a value that was ever real anywhere.
