# agent-once v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship version 1 of agent-once: a guard that makes agent side effects happen at most once (exactly once where a reconciler can confirm), delivered as an MCP proxy CLI, TypeScript and Python cores, Claude Agent SDK and Playwright MCP integrations, a chaos suite with four reference targets, CI plugins, docs and a reproducible RESULTS.md.

**Architecture:** One versioned SQLite ledger format (spec first, with shared test vectors) implemented by a TypeScript core and a Python core. A pure decision function decides execute, replay or in-doubt from the latest ledger entry; a Guard orchestrates claim, dispatch, record, reconcile and doubt delivery around it. The MCP proxy is a transparent JSON-RPC relay that intercepts `tools/call` and routes guarded calls through the Guard; browser servers get page-aware rules. The chaos suite runs scripted agents through fault scenarios against reference targets with a ground-truth API and an injected clock, so every result is deterministic.

**Tech Stack:** Node 22.13+ (ESM, `node:sqlite`), TypeScript strict, vitest, fast-check, `@modelcontextprotocol/sdk` 1.32.x; Python 3.10+ with uv, pytest, hypothesis, ruff, mypy --strict; GitHub Actions. No other runtime dependencies without a recorded reason.

**Spec:** /Users/hammed/code/agent-once/docs/design.md (the sections "Decisions after the builder check" and "Corrections to earlier claims" supersede earlier text).

## Verified facts (31 Oct 2026, recorded at plan time)

Name availability:
- npm: `agent-once`, `once-guard`, `mcp-once` all unpublished (404). The `@agent-once` npm scope does not exist yet; creating an org needs Hammed's npm account.
- PyPI: `agent-once` is TAKEN by frogscooper/once (v0.1.0 on 26 Oct 2026, v0.2.0 on 30 Oct 2026, GitHub repo created 21 Oct 2026, 0 stars). It is a direct competitor: a Python decorator that runs side-effecting tool calls at most once per idempotency key (SQLite or Postgres, import name `once`). `once-guard` and `mcp-once` are free on PyPI.
- Decision: npm package `agent-once` (one unscoped package with subpath exports, so no npm org is needed); PyPI distribution `once-guard` with import name `agent_once` (no clash with the competitor's `once`). Hammed to confirm at release time.

MCP tool annotations (servers run locally, `tools/list` read with the official SDK client):
- `@playwright/mcp` 0.0.83 (server "Playwright" 1.64.0-alpha): sets `readOnlyHint` and `destructiveHint` on every tool, never `idempotentHint`. Read-only: `browser_console_messages`, `browser_find`, `browser_network_requests`, `browser_network_request`, `browser_take_screenshot`, `browser_snapshot`, `browser_wait_for`. Every other tool, including `browser_hover`, `browser_resize`, `browser_navigate`, `browser_navigate_back`, `browser_type`, `browser_fill_form`, `browser_click`, is `destructiveHint: true`. Annotations alone would guard hovers and navigation, so the page-aware rules are required. Element arguments: `element` (human-readable description) and `target` (snapshot ref or selector). `browser_type` has `submit: boolean`.
- `chrome-devtools-mcp` 1.12.0 (server "chrome_devtools"): sets only `readOnlyHint`. `take_snapshot`, `take_screenshot` and `get_network_request` are marked `readOnlyHint: false` although they do not change the page. `click`, `fill`, `fill_form`, `hover`, `drag`, `upload_file` take a `uid` only (no human-readable description), so labels must come from the last `take_snapshot` output. `type_text` has `submitKey`.
- Neither server declares server-side elicitation. Neither sets `idempotentHint`.

MCP elicitation:
- `@modelcontextprotocol/sdk` 1.32.2, protocol 2025-11-25, exports `ElicitRequestSchema`; clients opt in with `capabilities.elicitation`.
- Claude Agent SDK 0.3.316: `Options.onElicitation?: OnElicitation` receives `{ serverName, message, mode, requestedSchema }`; `Elicitation` and `ElicitationResult` hook events exist (so Claude Code also handles elicitation). Other clients are detected at runtime from `initialize` capabilities; without the capability the proxy falls back to the structured error.

Toolchain on this machine: Node 22.23.4 (`node:sqlite` works, emits an ExperimentalWarning, SQLite 3.53.4), npm 10.9.9, uv 0.11.17 with CPython 3.10, 3.11, 3.12, 3.15, Playwright Chromium cached, `gh` logged in as ajibadedapo, no `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment.

## Global Constraints

- No code comments of any kind: no inline, block, docstrings, JSDoc, section banners. Enforced by `scripts/check-style.mjs` and `scripts/check_style.py` in CI.
- No em dashes (U+2014) anywhere in the repo: code, docs, commits. Enforced by the same check.
- Personal open source: no company branding and no mention of any employer. Author: Hammed Ajibade. Licence: Apache 2.0.
- Do not create a GitHub remote, push, publish to npm or PyPI, or post anywhere during the build (the release gate after the final review is handled by the integrating session, not by task subagents).
- TDD: every behaviour lands with a test that fails if the protection is removed. Fixed or injected time (`Clock`, `ManualClock`); no sleeps, no real timers in unit tests; non-zero milliseconds in fixed times (for example `1_761_912_345_678`).
- Default retry window 120 s; default ledger expiry 24 h; default settle window 10 s; SQLite WAL with `synchronous=NORMAL`, `busy_timeout=5000`.
- Guarantee wording, verbatim wherever it is stated: "at most once by default, exactly once wherever a reconciler can confirm the outcome".
- README first line, verbatim: `Stop your AI agent from charging, booking or sending twice.`
- Default side-effect patterns (case-insensitive word match): pay, buy, checkout, book, confirm, submit, send, delete, publish, plus order, purchase, place.
- Money class patterns: pay, buy, checkout, purchase, charge, order, payment, transfer. Irreversible class patterns: delete, publish, send, deploy. Everything else guarded is class `standard`.
- MCP `_meta` keys (reserved, reverse-DNS form): `io.github.ajibadedapo.agent-mandates/mandate-id`, `io.github.ajibadedapo/agent-once-session`, `io.github.ajibadedapo/agent-once-intent`, `io.github.ajibadedapo/agent-once` (status the proxy attaches to results), `io.github.ajibadedapo/agent-once-action` (action id the proxy forwards upstream).
- Proxy-originated JSON-RPC ids use the reserved string prefix `agent-once:`.
- Ledger home: `$AGENT_ONCE_HOME` else `~/.agent-once/`; ledger `ledger.db`, evidence `events.jsonl`. Both cores use the same defaults.
- No telemetry. No network calls except to the wrapped server, a configured webhook and chaos targets.
- Commit messages: `<area>: <what changed>` (areas: spec, core, py, proxy, browser, chaos, integrations, ci, bench, docs), ending with the attribution lines from the session system reminder if present.

## Review Focus

1. The upstream MCP server crashes or exits while a guarded call is in flight: the proxy must leave the action `sent` (in doubt, never `confirmed`), answer the pending client request with an error result, and exit with the upstream's code instead of hanging. Test in Task 6.
2. Ledger unavailable (file locked past busy timeout, unwritable directory, corrupt file, or a newer `schema_version`): guarded calls fail closed with a clear "agent-once ledger unavailable" error result; pass-policy tools keep working; a newer schema refuses to open with the version in the message. Tests in Tasks 3 and 6.
3. Two identical calls at once (parallel tool calls in one turn, or two proxy processes sharing one ledger): exactly one dispatch. Tests in Task 4 (in-process join) and Task 3 (two store handles on one file).
4. Large or binary results (screenshots, base64 images) and args with non-finite numbers: results over 256 KiB are stored as a truncated marker and replays say the effect is confirmed but the result was too large; NaN or Infinity in args raise a typed `CanonicalizationError` that the proxy reports as an error result without dispatching. Tests in Tasks 2 and 4.
5. Invalid config (bad JSON, unknown policy, invalid regex, unknown keys): the CLI exits non-zero before spawning the upstream, naming the file and the bad path. It must never start unguarded. Test in Task 6.

## Ledger semantics (shared by both cores; Task 1 writes this into `spec/ledger-v1.md` and the vectors)

Identity:
- `projected_args` = args with volatile keys removed at any depth (exact, case-sensitive key names: `timestamp`, `ts`, `nonce`, `request_id`, `requestId`, `idempotency_key`, `idempotencyKey`, `trace_id`, `traceId`, `_meta`), then the per-tool identity rule applied (`include: string[]` of top-level keys, or `exclude: string[]`). Browser profile also drops `element`, `target`, `ref`, `uid`, `pageId`, `from_uid`, `to_uid`, `slowly`, `includeSnapshot` and adds `page_url` (origin + path, no query or fragment) and `label` (label resolved from the snapshot by ref or uid, else the element text).
- `intent_hash` = lowercase hex SHA-256 of RFC 8785 (JCS) canonical JSON of `["agent-once/v1", session_key, tool, projected_args]`, or of `["agent-once/v1/intent", session_key, tool, intent_key]` when an explicit intent key is given.
- `action_id` = `"ao_"` + first 24 hex chars of SHA-256 of JCS `[intent_hash, occurrence, intended_at_ms]` (the at_ms of that occurrence's intended event, so pruning never reissues an old id).
- Session key on the proxy path, in order: `_meta["io.github.ajibadedapo.agent-mandates/mandate-id"]` (explicit), `_meta["io.github.ajibadedapo/agent-once-session"]` (explicit), env `AGENT_ONCE_SESSION` (explicit), else `clientInfo.name + ":" + cwd` (default, not explicit).

Ledger (SQLite, append-only):
```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  occurrence INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intended','sent','confirmed','failed','reconciled')),
  at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  session_explicit INTEGER NOT NULL,
  intent_key_explicit INTEGER NOT NULL,
  run_instance TEXT NOT NULL,
  tool TEXT NOT NULL,
  tool_class TEXT NOT NULL CHECK (tool_class IN ('money','irreversible','standard')),
  policy TEXT NOT NULL CHECK (policy IN ('guard','block-on-doubt')),
  args_json TEXT,
  detail_json TEXT NOT NULL
);
CREATE UNIQUE INDEX events_one_intended ON events(intent_hash, occurrence) WHERE state = 'intended';
CREATE INDEX events_by_intent ON events(intent_hash, occurrence, seq);
CREATE INDEX events_by_action ON events(action_id, seq);
CREATE INDEX events_by_expiry ON events(expires_at_ms);
```
`meta.schema_version = "1"`. `detail_json` keys by state: `confirmed` {result, result_truncated, delivery: "delivered"|"cancelled"}; `failed` {failure_kind: "error_result"|"transport_error"|"not_dispatched", error, result}; `reconciled` {outcome: "happened"|"not_happened", resolved_by: "reconciler"|"agent"|"human"|"webhook", result}; `intended`/`sent` {captured?: string}. Opening prunes rows with `expires_at_ms < now`. `args_json` is null when `storeArgs` is false.

Decision table (`decide`), input = latest event of the highest occurrence for the intent (or none), call context {run_instance, session_explicit, intent_key_explicit, policy}, now, retry window, expiry:

| Latest | Condition | Decision | reason |
|---|---|---|---|
| none or expired | | execute occurrence n (0, or last + 1) | `new` / `expired` |
| intended or sent | | in_doubt | `outcome_unknown` |
| failed, `not_dispatched` | | execute last + 1 | `not_dispatched` |
| failed | policy block-on-doubt | in_doubt | `failed_block_on_doubt` |
| failed | now < at + window | in_doubt | `failed_within_window` |
| failed | otherwise | execute last + 1 | `failed_after_window` |
| confirmed or reconciled(happened) | intent key explicit | replay | `replay_explicit_intent` |
| confirmed or reconciled(happened) | delivery cancelled or reconciled, now < at + window | replay | `replay_undelivered` |
| confirmed or reconciled(happened) | different run_instance, session explicit | replay | `replay_rerun_explicit_session` |
| confirmed or reconciled(happened) | different run_instance, default session, now < at + window | replay | `replay_rerun_within_window` |
| confirmed or reconciled(happened) | otherwise | execute last + 1 | `deliberate_repeat` |
| reconciled(not_happened) | | execute last + 1 | `reconciled_not_happened` |

In-doubt handling (Guard, not the pure function): run the tool's reconciler if any. `happened` is accepted at once; `not_happened` is accepted only when `now - sent_at >= settleWindow`, else treated as `unknown` with reason `too_soon`. Then: policy `guard` returns `in_doubt` (outcome unknown, agent may resolve); policy `block-on-doubt` (default for classes money and irreversible) asks the human resolver chain (elicitation, then webhook), and if unresolved returns `blocked`. An agent may resolve only `standard` class actions.

---

## Scope notes (deliberate, for Hammed to confirm)

- Postgres and Redis ledger adapters are 1.x: the `LedgerStore` interface is the seam. The Delivery section's v1 list does not include them; RESULTS.md says Postgres was not measured.
- Docs are Markdown in `docs/` rendered by GitHub; a generated docs site is 1.x.
- The Python package ships the core, HTTP key helper and pytest plugin, not a second proxy; the proxy is the npm CLI.
- OpenAI Agents SDK, Anthropic Messages tool loop, LangGraph and browser-use adapters are 1.x per the design.
- Remote (HTTP or SSE) MCP servers are not wrapped in v1; `guardMcpServers` reports them as unguarded.

## Task 1: Repo scaffold, style check and ledger spec with vectors

**Files:**
- Create: `package.json` (private workspace root, workspaces `packages/*`, `bench`), `tsconfig.base.json`, `.gitignore`, `.editorconfig`, `LICENSE` (Apache 2.0 full text, copyright 2026 Hammed Ajibade), `.nvmrc` (22)
- Create: `packages/agent-once/package.json` (name `agent-once`, version `0.1.0`, `type: module`, `engines.node >=22.13`, bin `agent-once` -> `dist/cli/main.js`, exports `.`, `./mcp`, `./chaos`, `./claude-agent-sdk`, `./playwright-mcp`, `./vitest`), `packages/agent-once/tsconfig.json`, `packages/agent-once/vitest.config.ts`
- Create: `python/pyproject.toml` (name `once-guard`, import package `agent_once`, `requires-python >=3.10`, hatchling, dev deps pytest, hypothesis, ruff, mypy), `python/src/agent_once/__init__.py`
- Create: `scripts/check-style.mjs`, `scripts/check_style.py`, `scripts/check-style.test.mjs`
- Create: `spec/ledger-v1.md` (also documents the vector formats), `spec/ledger-v1.sql`, `spec/vectors/canonical.json`, `spec/vectors/identity.json`, `spec/vectors/decisions.json`, `scripts/gen_identity_vectors.py`

**Interfaces:**
- Produces: vector file formats used by Tasks 2, 4, 5:
  - `canonical.json`: `[{ "name", "input", "canonical" }]` and `[{ "name", "input", "error": "non_finite" }]`
  - `identity.json`: `[{ "name", "session_key", "tool", "args", "identity_rule"?, "browser"?: {page_url, label}, "intent_key"?, "projected", "intent_hash", "occurrence", "action_id" }]`
  - `decisions.json`: `[{ "name", "now_ms", "retry_window_ms", "expiry_ms", "latest": null | {state, occurrence, at_ms, expires_at_ms, run_instance, detail}, "call": {run_instance, session_explicit, intent_key_explicit, policy}, "expect": {kind: "execute"|"replay"|"in_doubt", occurrence?, reason} }]`
- Produces: `npm run check:style` (both scripts) exit code 1 on violation with `path:line: message`.

- [ ] **Step 1: Scaffold** root and package manifests, install devDependencies (typescript, vitest, fast-check, @types/node, @modelcontextprotocol/sdk 1.32.x as a dependency of `agent-once`) with exact versions; `uv sync` in `python/`.
- [ ] **Step 2: Write failing tests for the style check** in `scripts/check-style.test.mjs` (run with `node --test`): `flags a line comment in a ts file`, `flags a block comment`, `flags an em dash in markdown`, `ignores comment-like text inside string literals`, `allows a shebang on line 1`. Python side in `scripts/check_style.py --self-test` covering `flags a comment token`, `flags a module or function docstring`, `ignores a hash inside a string`.
- [ ] **Step 3: Implement** `scripts/check-style.mjs` using the TypeScript scanner (`ts.createScanner` with `skipTrivia=false`, flag `SingleLineCommentTrivia` and `MultiLineCommentTrivia`) over tracked `.ts`, `.mts`, `.mjs`, `.js` files, and an em dash scan over every tracked text file; `scripts/check_style.py` uses `tokenize` COMMENT tokens and `ast.get_docstring` on modules, classes and functions.
- [ ] **Step 4: Write `spec/ledger-v1.md` and `spec/ledger-v1.sql`** from the "Ledger semantics" section of this plan (identity, schema, states, detail keys, decision table, in-doubt handling, settle window, expiry, schema-version refusal rule: a reader refuses `schema_version` greater than it knows).
- [ ] **Step 5: Write vectors.** `canonical.json` must include: key ordering by UTF-16 code units (`{"b":1,"a":2,"é":3,"z":4}`), integral float `1.0` -> `1`, `1e21` -> `1e+21`, `1e-7` -> `1e-7`, `0.1` -> `0.1`, `-0` -> `0`, unicode escapes (`" "` stays literal, control chars `\u001f` escaped), nested arrays, and two `non_finite` cases. `identity.json`: at least 8 cases (volatile key removal at depth, include rule, exclude rule, explicit intent key, browser page_url query stripping, occurrence 0 and 3). `decisions.json`: one case per row of the decision table plus boundaries (exactly at window end is outside the window; exactly at expiry is expired). Canonical vectors are written by hand from RFC 8785 (including its published number examples). Identity vectors use only strings, integers, booleans, null and nested objects or arrays with ASCII keys, so `json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)` equals JCS for them; `scripts/gen_identity_vectors.py` computes `projected`, `intent_hash` and `action_id` with `hashlib` and is committed so the vectors can be regenerated. Decision vectors need no hashes.
- [ ] **Step 6: Run** `node --test scripts/check-style.test.mjs` and `uv run --project python python scripts/check_style.py --self-test`, expect PASS; `npm run check:style` passes on the repo.
- [ ] **Step 7: Commit** `spec: ledger v1 format, shared vectors, repo scaffold and style check`.

## Task 2: TypeScript canonical JSON, identity and clocks

**Files:**
- Create: `packages/agent-once/src/canonical/jcs.ts`, `packages/agent-once/src/identity/project-args.ts`, `packages/agent-once/src/identity/identity.ts`, `packages/agent-once/src/time/clock.ts`
- Test: `packages/agent-once/test/canonical.test.ts`, `test/identity.test.ts`, `test/clock.test.ts`, `test/vectors.ts` (loader for `spec/vectors`)

**Interfaces:**
- Produces:
  - `type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }`
  - `class CanonicalizationError extends Error { readonly path: string }`
  - `canonicalize(value: unknown): string` (RFC 8785; throws `CanonicalizationError` for non-finite numbers, `undefined` inside arrays, functions, bigint)
  - `type IdentityRule = { include: string[] } | { exclude: string[] } | undefined`
  - `DEFAULT_VOLATILE_KEYS: readonly string[]`, `BROWSER_VOLATILE_KEYS: readonly string[]`
  - `projectArgs(args: Record<string, unknown>, rule: IdentityRule, volatileKeys: readonly string[]): JsonValue`
  - `intentHash(input: { sessionKey: string; tool: string; projectedArgs: JsonValue; intentKey?: string }): string`
  - `actionId(intentHash: string, occurrence: number, intendedAtMs: number): string`
  - `interface Clock { nowMs(): number; setTimer(ms: number, fn: () => void): { cancel(): void } }`, `systemClock: Clock`, `class ManualClock implements Clock { constructor(startMs: number); advance(ms: number): void }` (advance fires due timers in time order, including timers scheduled by fired timers)

- [ ] **Step 1: Write failing tests:** `canonical matches every spec vector`, `canonical throws CanonicalizationError with the path for NaN and Infinity`, `projectArgs removes volatile keys at any depth`, `include and exclude rules`, `intentHash and actionId match every identity vector`, `explicit intent key ignores args`, `ManualClock fires timers in order on advance and never early`, `ManualClock runs a timer scheduled by another timer within the same advance`.
- [ ] **Step 2: Run** `npx vitest run test/canonical.test.ts test/identity.test.ts test/clock.test.ts`, expect FAIL (modules missing).
- [ ] **Step 3: Implement.** Number serialisation follows ECMAScript `Number.prototype.toString` (which RFC 8785 adopts); hashing via `node:crypto` `createHash('sha256')`.
- [ ] **Step 4: Run** the same command, expect PASS.
- [ ] **Step 5: Commit** `core: canonical JSON, action identity and clocks`.

## Task 3: TypeScript ledger stores

**Files:**
- Create: `packages/agent-once/src/ledger/types.ts`, `src/ledger/sqlite-store.ts`, `src/ledger/memory-store.ts`, `src/ledger/errors.ts`, `src/ledger/suppress-sqlite-warning.ts`
- Test: `packages/agent-once/test/ledger.contract.ts` (shared contract run against both stores), `test/sqlite-store.test.ts`, `test/memory-store.test.ts`

**Interfaces:**
- Consumes: `Clock` (Task 2).
- Produces:
  - `type LedgerState = 'intended' | 'sent' | 'confirmed' | 'failed' | 'reconciled'`, `type ToolClass = 'money' | 'irreversible' | 'standard'`, `type GuardPolicy = 'guard' | 'block-on-doubt'`
  - `interface LedgerEvent { seq: number; actionId: string; intentHash: string; occurrence: number; state: LedgerState; atMs: number; expiresAtMs: number; sessionKey: string; sessionExplicit: boolean; intentKeyExplicit: boolean; runInstance: string; tool: string; toolClass: ToolClass; policy: GuardPolicy; argsJson: string | null; detail: Record<string, JsonValue> }`, `type NewLedgerEvent = Omit<LedgerEvent, 'seq'>`
  - `interface LedgerTx { latest(intentHash: string): LedgerEvent | undefined; append(event: NewLedgerEvent): LedgerEvent }`
  - `interface LedgerStore { transact<T>(fn: (tx: LedgerTx) => T): T; findAction(actionId: string): LedgerEvent | undefined; listInDoubt(nowMs: number): LedgerEvent[]; close(): void }`
  - `class SqliteLedgerStore implements LedgerStore { static open(path: string, clock: Clock): SqliteLedgerStore }`, `class MemoryLedgerStore implements LedgerStore { constructor(clock: Clock) }`
  - `class LedgerUnavailableError extends Error`, `class LedgerSchemaTooNewError extends LedgerUnavailableError { readonly found: number }`
  - `defaultLedgerPath(env: NodeJS.ProcessEnv, homedir: string): string`

- [ ] **Step 1: Write the failing contract tests** (run for both stores): `latest returns the highest occurrence's newest event`, `latest ignores expired events`, `append is visible to latest in the same transaction`, `a second intended for the same intent and occurrence throws`, `findAction returns the newest event for an action id`, `listInDoubt returns intended and sent actions that are not expired`. SQLite-only: `uses WAL and synchronous NORMAL` (PRAGMA reads 'wal' and 1), `prunes expired rows on open`, `refuses a newer schema_version with LedgerSchemaTooNewError naming the version`, `two store handles on one file: a transaction in the second sees the first's intended event` (Review Focus 3), `unwritable directory raises LedgerUnavailableError` (Review Focus 2), `corrupt file raises LedgerUnavailableError`, `round-trips detail and args JSON byte for byte`, `defaultLedgerPath honours AGENT_ONCE_HOME`.
- [ ] **Step 2: Run** `npx vitest run test/sqlite-store.test.ts test/memory-store.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** with `node:sqlite` `DatabaseSync`, schema from `spec/ledger-v1.sql`, `BEGIN IMMEDIATE` per `transact`, `PRAGMA busy_timeout=5000`. `suppress-sqlite-warning.ts` swallows only the `ExperimentalWarning` whose message mentions SQLite and re-emits all others.
- [ ] **Step 4: Run** the same command, expect PASS.
- [ ] **Step 5: Commit** `core: append-only SQLite and memory ledgers`.

## Task 4: TypeScript decision function, Guard, evidence and HTTP keys

**Files:**
- Create: `packages/agent-once/src/guard/decide.ts`, `src/guard/classify.ts`, `src/guard/guard.ts`, `src/guard/types.ts`, `src/guard/result-cap.ts`, `src/evidence/types.ts`, `src/evidence/jsonl-sink.ts`, `src/evidence/otel-sink.ts`, `src/http/guarded-fetch.ts`, `src/index.ts`
- Test: `test/decide.test.ts`, `test/classify.test.ts`, `test/guard.test.ts`, `test/guard.property.test.ts`, `test/evidence.test.ts`, `test/guarded-fetch.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  - `type Decision = { kind: 'execute'; occurrence: number; reason: string } | { kind: 'replay'; event: LedgerEvent; reason: string } | { kind: 'in_doubt'; event: LedgerEvent; reason: string }`
  - `decide(input: { latest: LedgerEvent | undefined; nowMs: number; retryWindowMs: number; call: { runInstance: string; sessionExplicit: boolean; intentKeyExplicit: boolean; policy: GuardPolicy } }): Decision`
  - `classifyTool(name: string, text: string, patterns: { money: string[]; irreversible: string[] }): ToolClass`, `DEFAULT_SIDE_EFFECT_PATTERNS`, `DEFAULT_MONEY_PATTERNS`, `DEFAULT_IRREVERSIBLE_PATTERNS`
  - `type ToolOutcome = { kind: 'ok'; result: JsonValue } | { kind: 'error_result'; result: JsonValue } | { kind: 'transport_error'; error: string } | { kind: 'not_dispatched'; error: string }`
  - `type ReconcileOutcome = { outcome: 'happened'; result?: JsonValue } | { outcome: 'not_happened' } | { outcome: 'unknown'; reason: string }`
  - `type Reconciler = (ctx: { tool: string; args: Record<string, unknown>; actionId: string; event: LedgerEvent }) => Promise<ReconcileOutcome>`
  - `type HumanResolution = 'happened' | 'not_happened' | 'unresolved'`; `interface HumanResolver { resolve(doubt: DoubtInfo): Promise<HumanResolution> }`
  - `interface DoubtInfo { actionId: string; tool: string; args: Record<string, unknown>; toolClass: ToolClass; reason: string; sinceMs: number }`
  - `interface GuardedCall { tool: string; args: Record<string, unknown>; sessionKey: string; sessionExplicit: boolean; intentKey?: string; policy: 'pass' | GuardPolicy; toolClass: ToolClass; identityRule?: IdentityRule; volatileKeys?: readonly string[]; extraIdentity?: Record<string, JsonValue>; reconciler?: Reconciler; captured?: string; signal?: AbortSignal }`
  - `type GuardResult = { status: 'executed' | 'passed'; actionId?: string; outcome: ToolOutcome } | { status: 'replayed'; actionId: string; result: JsonValue | null; resultTruncated: boolean; reason: string } | { status: 'in_doubt' | 'blocked'; doubt: DoubtInfo } | { status: 'ledger_unavailable'; error: string }`
  - `class Guard { constructor(deps: { store: LedgerStore; clock: Clock; runInstance: string; evidence: EvidenceSink; humanResolver?: HumanResolver; retryWindowMs?: number; expiryMs?: number; settleWindowMs?: number; storeArgs?: boolean; maxResultBytes?: number }); run(call: GuardedCall, execute: () => Promise<ToolOutcome>): Promise<GuardResult>; resolve(actionId: string, outcome: 'happened' | 'not_happened', by: 'agent' | 'human' | 'webhook'): ResolveResult; wrap<A extends Record<string, unknown>, R extends JsonValue>(meta: Omit<GuardedCall, 'args'>, fn: (args: A) => Promise<R>): (args: A) => Promise<R> }`
  - `type ResolveResult = { ok: true; event: LedgerEvent } | { ok: false; reason: 'unknown_action' | 'not_in_doubt' | 'agent_cannot_resolve_class' | 'too_soon' }` (an agent's `not_happened` is refused with `too_soon` inside the settle window, the same rule as reconcilers; humans and webhooks are authoritative)
  - `class ActionInDoubtError extends Error { readonly doubt: DoubtInfo; readonly blocked: boolean }` (thrown by `wrap` only)
  - `interface EvidenceSink { emit(event: EvidenceEvent): void }`, `type EvidenceEvent = { v: 1; atMs: number; kind: 'decision' | 'state' | 'resolve' | 'reconcile'; actionId?: string; tool: string; sessionKey: string; detail: Record<string, JsonValue> }`, `class JsonlEvidenceSink implements EvidenceSink { constructor(path: string) }`, `class OtelEvidenceSink implements EvidenceSink` (uses `@opentelemetry/api` when importable, optional peer dependency), `class FanoutEvidenceSink`
  - `guardedFetch(guard: Guard, call: Omit<GuardedCall, 'args'> & { args: Record<string, unknown> }, input: string | URL, init?: RequestInit, fetchImpl?: typeof fetch): Promise<GuardResult>` sets `Idempotency-Key: <actionId>` unless the caller set one.

- [ ] **Step 1: Write failing tests for `decide`:** `decide matches every decision vector` (from `spec/vectors/decisions.json`).
- [ ] **Step 2: Write failing tests for `Guard.run`** using `MemoryLedgerStore` and `ManualClock(1_761_912_345_678)`: `executes a new action once and records intended, sent, confirmed`, `a retry after a transport error within the window is in doubt and does not dispatch`, `a retry after the window executes a new occurrence`, `not_dispatched failure allows an immediate retry`, `reconciler happened turns doubt into a replay without dispatch`, `reconciler not_happened before the settle window is treated as unknown`, `reconciler not_happened after the settle window dispatches once`, `block-on-doubt asks the human resolver and blocks when unresolved`, `human happened replays and records reconciled by human`, `two concurrent identical runs dispatch once and both get the outcome` (Review Focus 3), `a call aborted by the client records delivery cancelled and the retry replays`, `pass policy dispatches without touching the ledger`, `a result over maxResultBytes is stored truncated and the replay reports resultTruncated` (Review Focus 4), `non-finite args return ledger-free error without dispatch` (Review Focus 4), `store throwing LedgerUnavailableError returns ledger_unavailable without dispatch` (Review Focus 2), `resolve by agent refuses money and irreversible classes`, `resolve not_happened by agent inside the settle window is refused as too_soon`, `wrap throws ActionInDoubtError when in doubt`.
- [ ] **Step 3: Write the failing property test** `guard.property.test.ts` with fast-check: a model target counts effects per intent; arbitrary sequences of {call, fault in [none, lost_after_commit, timeout_before_commit, slow_commit_then_land, not_dispatched], clock advance 0..200 s, resolve} for 1..3 intents; a perfect reconciler reads the model. Properties: `effects per intent never exceed one within the expiry window unless a deliberate repeat was decided` and `with retries continued past the settle window every intent ends with exactly one effect`. 500 runs, fixed seed in the config, plus `numRuns` from env for CI deep runs.
- [ ] **Step 4: Write failing tests** for `classifyTool` (word-boundary matching, money wins over irreversible), `JsonlEvidenceSink` appends one JSON line per event with `v: 1`, and `guardedFetch` (`sets Idempotency-Key to the action id`, `keeps a caller supplied key`, `a second identical call after a network error does not refetch`).
- [ ] **Step 5: Run** `npx vitest run test/decide.test.ts test/guard.test.ts test/guard.property.test.ts test/classify.test.ts test/evidence.test.ts test/guarded-fetch.test.ts`, expect FAIL.
- [ ] **Step 6: Implement.** Claim, decide and append `intended` in one `transact`; append `sent` right before `execute`; in-process join keyed by intent hash; settle measured from the `sent` event time.
- [ ] **Step 7: Run** the same command, expect PASS. Run `npx tsc --noEmit -p packages/agent-once`, expect no errors.
- [ ] **Step 8: Commit** `core: decision function, Guard, evidence and idempotency keys`.

## Task 5: Python core

**Files:**
- Create: `python/src/agent_once/canonical.py`, `identity.py`, `clock.py`, `ledger.py` (types, errors), `sqlite_store.py`, `memory_store.py`, `decide.py`, `classify.py`, `guard.py`, `evidence.py`, `http.py`, `py.typed`, `__init__.py` exports
- Test: `python/tests/test_vectors.py`, `test_ledger.py`, `test_guard.py`, `test_guard_property.py`, `test_interop.py`, `python/tests/interop_write.mjs`

**Interfaces:**
- Mirrors Task 2 to 4 names in snake_case: `canonicalize(value) -> str`, `CanonicalizationError`, `project_args(args, rule, volatile_keys)`, `intent_hash(session_key, tool, projected_args, intent_key=None)`, `action_id(intent_hash, occurrence, intended_at_ms)`, `Clock` protocol with `now_ms()`, `SystemClock`, `ManualClock(start_ms).advance(ms)`, `LedgerEvent` frozen dataclass, `SqliteLedgerStore.open(path, clock)`, `MemoryLedgerStore(clock)`, `LedgerUnavailableError`, `LedgerSchemaTooNewError`, `decide(latest, now_ms, retry_window_ms, call) -> Decision`, `Guard(store, clock, run_instance, evidence, human_resolver=None, retry_window_ms=120_000, expiry_ms=86_400_000, settle_window_ms=10_000, store_args=True, max_result_bytes=262_144)` with `run(call, execute) -> GuardResult`, `async arun(call, execute)`, `resolve(action_id, outcome, by)`, decorator `guard.tool(name=None, policy="guard", tool_class="standard", identity_rule=None, reconciler=None)` working on sync and async functions (raises `ActionInDoubt`), `JsonlEvidence(path)`, `idempotency_headers(action_id) -> dict[str, str]`.

- [ ] **Step 1: Write failing tests:** `test_canonical_vectors`, `test_identity_vectors`, `test_decision_vectors` (all three load `../spec/vectors`), ledger contract tests matching Task 3's list, guard tests matching Task 4 Step 2's list, hypothesis property test matching Task 4 Step 3 (`derandomize=True`, `max_examples=300`), `test_decorator_dedupes_sync_and_async`, `test_float_formatting_matches_ecmascript` (cases `1e21`, `1e-7`, `5e-324`, `123456789012345680000`).
- [ ] **Step 2: Write the failing interop test** `test_ts_written_ledger_reads_and_decides_identically`: runs `node python/tests/interop_write.mjs <tmp.db>` (imports the built TS package) which appends a confirmed and a sent action; Python opens the file, asserts `latest` fields equal and `decide` gives the same kinds the TS side printed as JSON. Also the reverse (`test_python_written_ledger_reads_in_ts`). If `node` is missing the test fails with a message, it does not skip.
- [ ] **Step 3: Run** `cd python && uv run pytest -q`, expect FAIL.
- [ ] **Step 4: Implement.** Floats use a `repr`-based shortest round-trip converted to ECMAScript exponent format; `sqlite3` with `isolation_level=None` and explicit `BEGIN IMMEDIATE`.
- [ ] **Step 5: Run** `cd python && uv run pytest -q && uv run mypy --strict src && uv run ruff check`, expect PASS. Run on 3.10 and 3.13 via `uv run --python 3.10 pytest -q`.
- [ ] **Step 6: Commit** `py: Python core with shared vectors and ledger interop`.

## Task 6: MCP proxy relay, config, session identity and CLI

**Files:**
- Create: `packages/agent-once/src/mcp/relay.ts`, `src/mcp/proxy.ts`, `src/mcp/session.ts`, `src/mcp/tool-policy.ts`, `src/mcp/resolve-tool.ts`, `src/mcp/result-format.ts`, `src/config/schema.ts`, `src/config/load.ts`, `src/cli/main.ts`, `src/cli/commands/mcp.ts`, `src/cli/commands/resolve.ts`, `src/cli/commands/ledger.ts`
- Test: `test/mcp/proxy.test.ts`, `test/mcp/session.test.ts`, `test/mcp/tool-policy.test.ts`, `test/config.test.ts`, `test/cli.test.ts`, fixtures `test/fixtures/counter-server.mjs` (MCP stdio server with tools `increment` (unannotated), `read_count` (readOnlyHint), `charge` (destructive), `crash_during` (exits mid-call), `slow` (responds when told via a control tool))

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces:
  - `type AgentOnceConfig` (validated, defaults filled): `{ ledger: { path: string; expiryHours: number; retryWindowSeconds: number; settleSeconds: number; storeArgs: boolean }; evidence: { jsonl: string | null }; approvalWebhook?: { url: string; timeoutSeconds: number; secretEnv?: string }; exposeResolveTool: boolean; tools: Record<string, ToolRule>; browser: BrowserConfig }` where `ToolRule = { policy?: 'guard' | 'pass' | 'block-on-doubt'; class?: ToolClass; identity?: IdentityRule; readBack?: ReadBackRule; notDispatchedErrors?: string[] }` and `ReadBackRule = { steps: { tool: string; args: Record<string, JsonValue> }[]; happened?: string; notHappened?: string }` (templating `{{args.<path>}}`, `{{action_id}}`, `{{captured}}`, `{{origin}}`). `BrowserConfig` is defined in Task 8; this task accepts and validates `browser.enabled: 'auto' | boolean` and passes the rest through.
  - `loadConfig(opts: { path?: string; cwd: string; env: NodeJS.ProcessEnv; homedir: string }): AgentOnceConfig` throws `ConfigError` with `file` and `path` (JSON pointer)
  - `resolveSession(meta: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv, clientName: string | undefined, cwd: string): { key: string; explicit: boolean; source: 'mandate' | 'meta' | 'env' | 'default' }`
  - `resolveToolPolicy(name: string, annotations: ToolAnnotations | undefined, config: AgentOnceConfig): { policy: 'pass' | GuardPolicy; toolClass: ToolClass }` rules: config glob match first; else `readOnlyHint === true` -> pass; else `destructiveHint === false && idempotentHint === true` -> pass; else guard with class from `classifyTool`, money and irreversible default to `block-on-doubt`.
  - `createProxy(deps: { client: Transport; upstream: Transport; guard: Guard; config: AgentOnceConfig; clock: Clock; cwd: string; env: NodeJS.ProcessEnv; extensions?: ProxyExtension[]; humanResolverFactory?: (ctx: ProxyContext) => HumanResolver | undefined }): Promise<RunningProxy>`; `RunningProxy { closed: Promise<{ upstreamExitCode: number | null }>; close(): Promise<void> }`
  - `interface ProxyExtension { onClientRequest?(msg, ctx): void; onUpstreamResult?(tool: string, args, result, ctx): void; adjustCall?(call: GuardedCall, ctx): GuardedCall; classifyOutcome?(tool: string, result): ToolOutcome | undefined; reconcilerFor?(tool: string, args, ctx): Reconciler | undefined }` (Task 8 implements the browser extension; Task 7 uses `ProxyContext.requestClient`)
  - `interface ProxyContext { clientCapabilities: ClientCapabilities; clientInfo?: Implementation; requestClient(method: string, params: unknown): Promise<unknown>; callUpstreamTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> }`
  - CLI: `agent-once mcp [--config <file>] [--session <key>] -- <command> [args...]`, `agent-once resolve <action_id> --happened|--not-happened`, `agent-once ledger list [--in-doubt] [--json]`, exit codes: 0 ok, 2 config error, 3 ledger unavailable at startup, otherwise upstream's exit code.

Relay behaviour (decided here, tested below): forward every client message to upstream and every upstream message to client, except: client `tools/call` requests (routed through Guard unless policy `pass`); `tools/call` for `agent_once_resolve` (answered locally); upstream `tools/list` results (annotations captured per tool, `agent_once_resolve` appended on the last page when `exposeResolveTool`); responses to `agent-once:` ids. If a `tools/call` names a tool with unknown annotations, the proxy fetches all `tools/list` pages from upstream first. Client `notifications/cancelled` for a guarded in-flight request is absorbed (logged, not forwarded) and marks delivery cancelled; for pass calls it is forwarded. Guarded call results: executed results are forwarded unchanged plus `_meta["io.github.ajibadedapo/agent-once"] = { status, action_id }`; replays prepend a text item `agent-once: this action already happened (action <id>); returning the recorded result instead of repeating it.`; in-doubt and blocked return `isError: true` with exact instructions (Task 7 owns the wording). The proxy forwards `_meta["io.github.ajibadedapo/agent-once-action"] = <actionId>` on guarded upstream calls.

- [ ] **Step 1: Write failing tests** (client side via SDK `InMemoryTransport.createLinkedPair()` and `Client` with and without `elicitation` capability; upstream is `counter-server.mjs` over `StdioClientTransport`): `passes initialize, tools/list, resources and notifications through unchanged apart from the appended resolve tool`, `tools/list pagination appends the resolve tool only on the last page`, `read-only tool passes without a ledger entry`, `unannotated tool is guarded`, `a retry after an error result within the window does not reach upstream` (upstream counter stays 1), `a confirmed call repeated in the same run executes as a deliberate repeat`, `a rerun with a new proxy instance and AGENT_ONCE_SESSION replays a confirmed call`, `client cancellation of a guarded call is not forwarded and the retry replays`, `agent_once_resolve not_happened lets the next call dispatch`, `upstream crash mid-call leaves the action sent, answers the client with an error and closed resolves with the exit code` (Review Focus 1), `ledger unavailable makes guarded calls return an error result while read tools still work` (Review Focus 2), `session from mandate meta wins over env`.
- [ ] **Step 2: Write failing config and CLI tests:** `zero config yields defaults under AGENT_ONCE_HOME`, `invalid JSON, unknown policy, invalid regex and unknown keys raise ConfigError naming file and JSON pointer` (Review Focus 5), `cli mcp exits 2 on bad config without spawning upstream` (spawn the built CLI with an upstream command that would create a marker file; assert the file does not exist), `cli resolve marks an in-doubt action happened`, `cli ledger list --in-doubt --json prints in-doubt actions`.
- [ ] **Step 3: Run** `npx vitest run test/mcp test/config.test.ts test/cli.test.ts`, expect FAIL.
- [ ] **Step 4: Implement.** Use SDK `StdioServerTransport` (client side) and `StdioClientTransport` (upstream, `stderr: 'inherit'`) as raw transports; never instantiate SDK `Server`/`Client` in the relay. `runInstance` is `crypto.randomUUID()` injected by the CLI.
- [ ] **Step 5: Run** the same command, expect PASS; `npm run build -w agent-once` succeeds.
- [ ] **Step 6: Commit** `proxy: transparent MCP relay with guarded tools/call, config and CLI`.

## Task 7: Doubt delivery: elicitation, approval webhook, structured error

**Files:**
- Create: `packages/agent-once/src/mcp/doubt/elicitation-resolver.ts`, `src/mcp/doubt/webhook-resolver.ts`, `src/mcp/doubt/chain-resolver.ts`, `src/mcp/doubt/messages.ts`
- Test: `test/mcp/doubt.test.ts`

**Interfaces:**
- Consumes: `HumanResolver`, `DoubtInfo` (Task 4), `ProxyContext.requestClient` (Task 6).
- Produces:
  - `class ElicitationResolver implements HumanResolver { constructor(ctx: ProxyContext) }` sends `elicitation/create` with `message` from `doubtQuestion(doubt)` and `requestedSchema = { type: 'object', properties: { agent_once_outcome: { type: 'string', title: 'Did it happen?', enum: ['happened', 'not_happened'], enumNames: ['Yes, it happened', 'No, it did not happen'] } }, required: ['agent_once_outcome'] }`; `accept` maps to the value, `decline` or `cancel` to `unresolved`.
  - `class WebhookResolver implements HumanResolver { constructor(cfg: { url: string; timeoutSeconds: number; secret?: string }, clock: Clock, fetchImpl?: typeof fetch) }` POSTs `{ type: 'agent-once.approval_request', action_id, tool, args, class, reason, since_ms }`, header `X-Agent-Once-Signature: sha256=<hex HMAC-SHA256 of body>` when a secret is set; accepts only HTTP 200 with JSON `{ "outcome": "happened" | "not_happened" | "unresolved" }`; anything else, or timeout, is `unresolved`.
  - `class ChainResolver implements HumanResolver { constructor(resolvers: HumanResolver[]) }` returns the first non-`unresolved` answer.
  - `doubtQuestion(d: DoubtInfo): string`, `inDoubtToolResult(d: DoubtInfo, agentMayResolve: boolean): CallToolResult`, `blockedToolResult(d: DoubtInfo): CallToolResult`

Exact copy (tests assert it):
- In doubt: `agent-once stopped this call: an earlier identical <tool> call (action <id>) may already have taken effect and its outcome is unknown. Do not retry it. Check whether it happened (for example, read the page or list the records), then call agent_once_resolve with action_id "<id>" and outcome "happened" or "not_happened".`
- Blocked: `agent-once blocked this call: an earlier identical <tool> call (action <id>) may already have taken effect and its outcome is unknown. This is a <class> action, so a person must confirm before anything is retried. Ask the user to run: npx agent-once resolve <id> --happened (or --not-happened).`
- Question: `agent-once: an earlier <tool> call (action <id>) may already have happened, and repeating it could <charge|send|act> twice. Did it happen?` (`charge` for money, `send` for irreversible, `act` otherwise)

- [ ] **Step 1: Write failing tests:** `client with elicitation capability is asked and happened replays`, `client without elicitation capability gets the blocked result without an elicitation request`, `decline falls back to the webhook`, `webhook signs the body and maps outcomes`, `webhook non-200, bad JSON and timeout are unresolved` (timeout via `ManualClock` and an `AbortSignal`, no real waiting), `blocked result stays blocked on every retry until resolved`, `agent_once_resolve is refused for money class with the blocked copy`, `exact copy for in-doubt, blocked and question`.
- [ ] **Step 2: Run** `npx vitest run test/mcp/doubt.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** and wire `humanResolverFactory` in the CLI: `ChainResolver([ElicitationResolver if client declared elicitation, WebhookResolver if configured])`.
- [ ] **Step 4: Run** the same command plus `test/mcp`, expect PASS.
- [ ] **Step 5: Commit** `proxy: elicitation, approval webhook and structured doubt results`.

## Task 8: Page-aware rules for browser MCP servers

**Files:**
- Create: `packages/agent-once/src/mcp/browser/profile.ts`, `src/mcp/browser/page-state.ts`, `src/mcp/browser/snapshot-labels.ts`, `src/mcp/browser/rules.ts`, `src/mcp/browser/outcome.ts`, `src/mcp/browser/read-back.ts`, `src/mcp/browser/extension.ts`, `src/mcp/read-back-reconciler.ts`, `src/mcp/template.ts`
- Test: `test/browser/*.test.ts`, fixtures `test/fixtures/browser/playwright-*.json` and `chrome-devtools-*.json` captured from real servers (Step 1)

**Interfaces:**
- Consumes: `ProxyExtension`, `ReadBackRule`, `Reconciler` (Tasks 4 and 6).
- Produces:
  - `type BrowserConfig = { enabled: 'auto' | boolean; sideEffectPatterns: string[]; moneyPatterns: string[]; irreversiblePatterns: string[]; notDispatchedErrors: string[]; successMarkers: string[]; failureMarkers: string[]; capture: { urlPattern: string; regex: string }[]; readBack: ({ urlPattern: string } & ReadBackRule)[] }`, `DEFAULT_BROWSER_CONFIG`
  - `detectBrowserProfile(serverInfo: Implementation | undefined, command: string[]): 'playwright' | 'chrome-devtools' | undefined` (serverInfo names `Playwright` and `chrome_devtools`, or command containing `@playwright/mcp` / `chrome-devtools-mcp`)
  - `class PageState { url(): string | undefined; labelFor(ref: string): string | undefined; lastText(): string; observe(tool: string, args: Record<string, unknown>, resultText: string): void }` parses `Page URL: <url>` lines and `navigate_page`/`new_page`/`browser_navigate` url args; labels from Playwright snapshot lines `- <role> "<name>" [ref=<ref>]` and chrome-devtools lines `uid=<uid> <role> "<name>"`
  - `browserCallRule(profile, tool: string, args, page: PageState, cfg: BrowserConfig): { policy: 'pass' | GuardPolicy; toolClass: ToolClass; extraIdentity?: { page_url: string; label: string }; captured?: string }`. Side-effect tools: Playwright `browser_click`, `browser_type` with `submit: true`, `browser_press_key` with key `Enter`, `browser_select_option`, `browser_file_upload`, `browser_drop`; chrome-devtools `click`, `type_text` with `submitKey`, `press_key` Enter, `upload_file`, `drag`. A side-effect tool is guarded only when the label, the element description or the page URL matches `sideEffectPatterns`; everything else passes (navigate, hover, resize, fill, snapshot, screenshot, evaluate, tabs).
  - `classifyBrowserOutcome(resultText: string, isError: boolean, cfg: BrowserConfig): ToolOutcome` -> `not_dispatched` when text matches `notDispatchedErrors` (defaults `Ref \S+ not found`, `No element`, `not attached`, `Element is not visible`, `stale`); `ok` when a `successMarkers` pattern matches; `error_result` when `failureMarkers` match (defaults `ERR_[A-Z_]+`, `This site can.t be reached`, `502|503|504 `, `timed out`) or neither matches (a click whose effect cannot be confirmed is treated as failed so a quick retry goes to doubt).
  - `class ReadBackReconciler { constructor(rule: ReadBackRule, ctx: ProxyContext); reconcile: Reconciler }` runs steps via `ctx.callUpstreamTool`, renders templates, matches `happened` first then `notHappened`, else `unknown`.
  - `browserExtension(cfg: BrowserConfig): ProxyExtension`
- Default `successMarkers`: `order (number|#|confirmed)`, `booking (confirmed|reference)`, `(message|email) sent`, `ticket .* created`, `thank you for your (order|purchase|booking)`.

- [ ] **Step 1: Capture fixtures** from the real servers (the plan-time scratch install at `/tmp/ao-verify` or a fresh one): a Playwright `browser_snapshot` and `browser_click` result on a local page with a "Place order" button, and a chrome-devtools `take_snapshot` and `click` result on the same page. Store raw `CallToolResult` JSON.
- [ ] **Step 2: Write failing tests:** `detects both profiles from serverInfo and command`, `PageState reads the URL and labels from both snapshot formats`, `clicking "Place order" is guarded as money with page_url and label identity`, `hover, navigate and a click on "Next page" pass`, `chrome-devtools click by uid resolves the label from the last snapshot`, `a click whose uid has no known label on a checkout URL is guarded`, `stale ref error is not_dispatched and the retry dispatches at once`, `error page text is error_result and a quick retry is in doubt`, `read-back with templated steps reports happened, not_happened and unknown`, `captured order reference from the snapshot is stored and used in the read-back template`, `element refs do not change identity across snapshots`.
- [ ] **Step 3: Run** `npx vitest run test/browser`, expect FAIL.
- [ ] **Step 4: Implement** and register the extension in the CLI when `browser.enabled` is true or `auto` with a detected profile.
- [ ] **Step 5: Run** `npx vitest run test/browser test/mcp`, expect PASS.
- [ ] **Step 6: Commit** `browser: page-aware rules, outcome markers and read-back for browser MCP servers`.

## Task 9: Chaos reference targets

**Files:**
- Create: `packages/agent-once/src/chaos/targets/server.ts`, `src/chaos/targets/store.ts`, `src/chaos/targets/faults.ts`, `src/chaos/targets/api-routes.ts`, `src/chaos/targets/ui-pages.ts`, `src/chaos/targets/catalog.ts` (the four targets), `src/chaos/targets-mcp/server.ts`, `src/chaos/presets.ts`, CLI `src/cli/commands/chaos.ts` (subcommands `serve` and `targets-mcp`)
- Test: `test/chaos/targets.test.ts`, `test/chaos/faults.test.ts`, `test/chaos/targets-mcp.test.ts`

**Interfaces:**
- Consumes: `Clock`, `ManualClock`.
- Produces:
  - `type TargetName = 'checkout' | 'booking' | 'email' | 'ticket'`
  - `type FaultKind = 'none' | 'lost_response_after_commit' | 'slow_commit' | 'timeout_before_commit' | 'stale_element'` (crash mid-run is a runner scenario, Task 10)
  - `type FaultPlan = { target: TargetName; nth: number; kind: FaultKind; holdMs: number }[]`
  - `type Effect = { id: string; target: TargetName; fields: Record<string, string>; clientRef: string | null; atMs: number }`
  - `startTargets(opts: { clock: Clock; port?: number; honourIdempotencyKey?: boolean }): Promise<RunningTargets>`; `RunningTargets { url: string; setFaults(plan: FaultPlan): void; truth(): Record<TargetName, Effect[]>; reset(): void; pendingCommits(): number; close(): Promise<void> }`
  - HTTP: `POST /api/<target>` (JSON body; checkout `{item, qty}`, booking `{slot, name}`, email `{to, subject, body}`, ticket `{title, body}`; header `Idempotency-Key` stored as `clientRef`, deduped only when `honourIdempotencyKey`), `GET /api/<target>` lists effects, UI `GET /<target>` (form with a visible `Reference F-<n>` token and a submit button: "Place order", "Book slot", "Send message", "Create ticket"), `POST /<target>/submit` (confirmation page: `Order ORD-<n> confirmed (reference F-<n>)`, `Booking BK-<n> confirmed`, `Message MSG-<n> sent`, `Ticket TCK-<n> created`), `GET /<target>/history` (lists references), ground truth `GET /__truth`, `POST /__reset`, `POST /__faults`.
  - Fault semantics: `lost_response_after_commit` commits then destroys the socket; `slow_commit` destroys the socket, then commits when `clock` reaches arrival + `holdMs`; `timeout_before_commit` destroys the socket and never commits; `stale_element` answers 409 `{"error":"stale form: nothing was submitted"}` (UI: re-renders the form with new element names) without committing.
  - Targets MCP server (`agent-once chaos targets-mcp --url <targets url> [--timeout-ms 5000]`): tools `place_order`, `book_slot`, `send_email`, `create_ticket` (`destructiveHint: true`, `idempotentHint: false`) and `list_orders`, `list_bookings`, `list_sent_emails`, `list_tickets` (`readOnlyHint: true`); forwards `_meta["io.github.ajibadedapo/agent-once-action"]` as `Idempotency-Key`; socket errors and timeouts return `isError: true` with `request failed: <reason>`; 409 returns `isError: true` with the stale text.
  - `chaosTargetsPreset(): Pick<AgentOnceConfig, 'tools' | 'browser'>` with read-back rules: `place_order` -> `list_orders`, happened `"clientRef":"{{action_id}}"`, notHappened `^\[` (list returned without the ref), same for the other three; browser read-back per target: navigate `{{origin}}/<target>/history`, snapshot, happened `{{captured}}`, notHappened `History`; capture regex `Reference (F-\d+)`; `notDispatchedErrors` adds `stale form: nothing was submitted`.

- [ ] **Step 1: Write failing tests** with `ManualClock` and in-process `startTargets`: `each target commits one effect per accepted request and truth lists it`, `lost_response_after_commit commits and the client sees a socket error`, `slow_commit commits only after the clock passes holdMs`, `timeout_before_commit never commits`, `stale_element returns 409 without committing`, `nth counts only mutating requests to that target`, `UI form submit commits and the history page shows the reference`, `targets-mcp tools map to the API and surface faults as error results`, `read-back preset finds an effect by action id`.
- [ ] **Step 2: Run** `npx vitest run test/chaos/targets.test.ts test/chaos/faults.test.ts test/chaos/targets-mcp.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** with `node:http` only.
- [ ] **Step 4: Run** the same command, expect PASS.
- [ ] **Step 5: Commit** `chaos: four reference targets with ground truth, faults and an MCP front end`.

## Task 10: Chaos runner, scripted agents, scenarios and checker

**Files:**
- Create: `packages/agent-once/src/chaos/scenarios.ts`, `src/chaos/agents/scripted-api-agent.ts`, `src/chaos/agents/external-agent.ts`, `src/chaos/checker.ts`, `src/chaos/runner.ts`, `src/chaos/report.ts`, extend `src/cli/commands/chaos.ts` with `run`
- Test: `test/chaos/runner.test.ts`, `test/chaos/checker.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 6, 7, 9.
- Produces:
  - Scenario hold times: `slow_commit` 5_000 ms, `timeout_before_commit` 5_000 ms, `crash_mid_run` 5_000 ms with the rerun at +6 s of injected time.
  - `type ScenarioName = 'lost_response_after_commit' | 'slow_commit' | 'timeout_before_commit' | 'stale_element' | 'crash_mid_run'`; `SCENARIOS: Record<ScenarioName, { faultKind: FaultKind; holdMs: number; crash: boolean }>` (crash_mid_run: `slow_commit` fault with `holdMs` 5_000, agent and proxy dropped after dispatch, rerun with a new proxy instance on the same ledger and explicit session)
  - `type AgentKind = 'scripted:naive' | 'scripted:obedient' | { external: string[] }`
  - Scripted naive agent: one task per target, calls the mutating tool, on any error result retries the identical call after 2 s, 4 s and 8 s of injected time, ignores agent-once instructions. Obedient agent: same, but on an agent-once in-doubt result calls the matching list tool, calls `agent_once_resolve` with what it saw, and on "unknown" waits 15 s of injected time before retrying.
  - `runScenario(opts: { scenario: ScenarioName; target: TargetName; agent: AgentKind; guard: boolean; clock: ManualClock | 'real'; ledgerDir: string; seed: number }): Promise<RunRecord>`; `RunRecord = { scenario; target; agent: string; guard: boolean; effects: number; duplicate: boolean; missing: boolean; agentCalls: number; blockedOrDoubt: number; durationMs: number }`
  - `checkEffects(truth: Effect[], expected: 1): { effects: number; duplicate: boolean; missing: boolean }` (evaluated after flushing pending commits by advancing the clock past every hold)
  - `runMatrix(opts): Promise<RunRecord[]>`, `summarize(records): MatrixSummary` (rates per agent, guard, scenario, target), `renderMarkdown(summary): string`
  - CLI: `agent-once chaos run [--agent scripted:naive|scripted:obedient|"<command>"] [--scenarios a,b] [--targets a,b] [--guard on|off|both] [--runs N] [--json <file>] [--markdown <file>] [--fail-on-duplicates]`, exit 1 when `--fail-on-duplicates` and any guarded run duplicated. External agents receive env `AGENT_ONCE_CHAOS_URL`, `AGENT_ONCE_CHAOS_MCP` (JSON array: the command that starts the targets MCP server, wrapped in `agent-once mcp --` when guard is on), `AGENT_ONCE_TASK`, `AGENT_ONCE_SESSION`; they run on the real clock with `holdMs` 2_000 and settle 3 s.

Expected deterministic results (these are the acceptance assertions):

| Scenario | naive, no guard | naive, guard | obedient, guard |
|---|---|---|---|
| lost_response_after_commit | 2 effects (duplicate) | 1 | 1 |
| slow_commit | 2 (duplicate) | 1 | 1 |
| timeout_before_commit | 1 | 1 | 1 |
| stale_element | 1 | 1 | 1 |
| crash_mid_run | 2 (duplicate) | 1 | 1 |

- [ ] **Step 1: Write failing tests:** `the table holds for every target` (parametrised over the 4 targets, the 5 scenarios and the 3 columns), `checker flags duplicate and missing`, `no-fault runs produce exactly one effect with and without the guard`, `matrix markdown lists duplicate and missing rates with run counts`, `an external agent command receives the documented env vars` (fixture agent script echoes env to a file), `--fail-on-duplicates exits 1 when a guarded run duplicates` (inject a run record).
- [ ] **Step 2: Run** `npx vitest run test/chaos/runner.test.ts test/chaos/checker.test.ts`, expect FAIL.
- [ ] **Step 3: Implement.** The deterministic path runs targets, proxy (`createProxy` with in-memory client transport) and targets MCP server in one process with one `ManualClock`; the targets MCP server runs in-process over `InMemoryTransport` for this path.
- [ ] **Step 4: Run** the same command, expect PASS. If any guarded cell shows a duplicate or a missing effect, that is a guard bug: debug with superpowers:systematic-debugging, do not change the expected table.
- [ ] **Step 5: Commit** `chaos: scenarios, scripted agents, checker and chaos run CLI`.

## Task 11: Claude Agent SDK and Playwright MCP integrations

**Files:**
- Create: `packages/agent-once/src/integrations/claude-agent-sdk.ts`, `src/integrations/playwright-mcp.ts`, `examples/claude-agent-sdk/checkout.ts`, `examples/playwright-mcp/agent-once.config.json` (Claude Code, Claude Desktop and Cursor snippets live in docs, Task 14)
- Test: `test/integrations/claude-agent-sdk.test.ts`, `test/integrations/playwright-mcp.e2e.test.ts` (tagged browser, runs with `npm run test:browser`)

**Interfaces:**
- Consumes: Tasks 4, 6, 7, 8, 9.
- Produces:
  - `guardMcpServers(servers: Record<string, McpServerConfig>, opts?: { session?: string; configPath?: string; cliPath?: string }): { servers: Record<string, McpServerConfig>; unguarded: string[] }` wraps stdio entries as `{ command: process.execPath, args: [cliPath, 'mcp', ...(configPath ? ['--config', configPath] : []), '--', command, ...args], env: { ...env, AGENT_ONCE_SESSION: session } }`; non-stdio entries are returned unchanged and named in `unguarded`.
  - `guardSdkTool<T>(guard: Guard, tool: T, meta: { policy?: GuardPolicy; toolClass?: ToolClass; sessionKey: string; identityRule?: IdentityRule }): T` wraps an Agent SDK `tool()` definition handler; in-doubt returns `{ isError: true, content: [{ type: 'text', text: <in-doubt copy> }] }`.
  - `agentOnceElicitationHandler(ask: (q: { message: string; serverName: string }) => Promise<HumanResolution>, fallback?: OnElicitation): OnElicitation` recognises agent-once requests by the `agent_once_outcome` property in `requestedSchema`.
  - `playwrightMcpServer(opts?: { version?: string; headless?: boolean; config?: string; session?: string }): McpServerConfig` producing `npx agent-once mcp [--config ...] -- npx @playwright/mcp@<version> [--headless]`; default version pinned to the one verified in Task 8 fixtures.
  - `@anthropic-ai/claude-agent-sdk` is an optional peer dependency; types imported with `import type` only.

- [ ] **Step 1: Write failing tests:** `guardMcpServers wraps stdio servers and reports http servers as unguarded`, `wrapped config launches a working proxy` (spawn the wrapped command against `counter-server.mjs`, list tools, see `agent_once_resolve`), `guardSdkTool dedupes a retried handler`, `elicitation handler answers agent-once requests and delegates others`, `playwrightMcpServer builds the expected command`. E2E (browser): `Playwright MCP behind the proxy: scripted browser agent hits lost_response_after_commit on checkout and the target records one order` and the same without the guard records two.
- [ ] **Step 2: Run** `npx vitest run test/integrations/claude-agent-sdk.test.ts`, expect FAIL; `npm run test:browser`, expect FAIL.
- [ ] **Step 3: Implement**, plus `examples/claude-agent-sdk/checkout.ts` (uses `query()` with `guardMcpServers` and `agentOnceElicitationHandler`; exits with a clear message when `ANTHROPIC_API_KEY` is unset; never run in tests).
- [ ] **Step 4: Run** both commands, expect PASS. Run `npx tsc --noEmit` on the example.
- [ ] **Step 5: Commit** `integrations: Claude Agent SDK helpers and Playwright MCP preset`.

## Task 12: vitest plugin, pytest plugin, GitHub Action and CI

**Files:**
- Create: `packages/agent-once/src/vitest/index.ts`, `python/src/agent_once/pytest_plugin.py`, `python/src/agent_once/chaos_client.py`, `action.yml`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Test: `packages/agent-once/test/vitest-plugin.test.ts`, `python/tests/test_pytest_plugin.py` (uses `pytester`), `scripts/check-action.test.mjs`

**Interfaces:**
- Consumes: Tasks 9 and 10; Python core (Task 5).
- Produces:
  - vitest: `startChaosTargets(opts?: { faults?: FaultPlan }): Promise<ChaosHandle>`, `ChaosHandle { url: string; mcpCommand(guard: boolean): string[]; truth(): Promise<Record<TargetName, Effect[]>>; close(): Promise<void> }`, matchers `expect(handle).toHaveNoDuplicateEffects()` and `toHaveExactlyOneEffect(target)` registered by `import 'agent-once/vitest'` via `expect.extend`.
  - pytest (entry point `pytest11 = { agent_once = "agent_once.pytest_plugin" }`): fixtures `once_guard` (Guard on a temp SQLite ledger with `ManualClock`), `chaos_targets` (spawns `npx agent-once chaos serve --port 0` or `$AGENT_ONCE_CLI`, parses the printed URL, yields a `ChaosTargets` client with `url`, `set_faults(plan)`, `truth()`, `assert_no_duplicates()`, `assert_exactly_one(target)`); marker `chaos`.
  - `action.yml` (composite): inputs `agent-command` (required), `scenarios` (default all), `targets` (default all), `guard` (default `on`), `runs` (default `3`), `fail-on-duplicates` (default `true`), `agent-once-version` (default `latest`); runs `npx --yes agent-once@<version> chaos run ... --markdown "$GITHUB_STEP_SUMMARY" --json agent-once-chaos.json` and uploads the JSON as an artefact.
  - `ci.yml` jobs: style (both checkers), ts (Node 22 and 24: typecheck, vitest), python (3.10 to 3.13: ruff, mypy, pytest), interop, chaos (`chaos run --agent scripted:naive --guard both --fail-on-duplicates`), browser (Playwright Chromium, `npm run test:browser`), bench-smoke (latency only).
  - `release.yml` on tags `v*`: npm `publish --provenance --access public` and PyPI trusted publishing with attestations, both behind a `release` environment requiring approval. Never triggered during the build.

- [ ] **Step 1: Write failing tests:** vitest `matchers pass on one effect and fail with a readable message on two`, `mcpCommand wraps with the proxy when guard is true`; pytest via `pytester`: `once_guard fixture dedupes a decorated function`, `chaos_targets fixture records a duplicate from an unguarded double call and assert_no_duplicates fails`; `check-action.test.mjs`: `action.yml inputs match the chaos run flags` (parse with the `yaml` dev dependency; assert every input maps to a flag listed by `agent-once chaos run --help`).
- [ ] **Step 2: Run** `npx vitest run test/vitest-plugin.test.ts`, `cd python && uv run pytest tests/test_pytest_plugin.py -q`, `node --test scripts/check-action.test.mjs`, expect FAIL.
- [ ] **Step 3: Implement**; validate workflow syntax locally with `npx --yes @action-validator/cli .github/workflows/ci.yml` (or `actionlint` if installed) and record which was used.
- [ ] **Step 4: Run** the same commands, expect PASS.
- [ ] **Step 5: Commit** `ci: vitest and pytest plugins, GitHub Action, CI and release workflows`.

## Task 13: Benchmark harness and RESULTS.md

**Files:**
- Create: `bench/package.json` (private), `bench/src/latency.ts`, `bench/src/latency-python.py`, `bench/src/matrix.ts`, `bench/src/browser-agent.ts`, `bench/src/real-agents/claude-agent-sdk.ts`, `bench/src/real-agents/openai.ts`, `bench/src/results-md.ts`, `bench/src/main.ts`, `RESULTS.md` (generated)
- Test: `bench/test/results-md.test.ts`, `bench/test/real-agents-gate.test.ts`

**Interfaces:**
- Consumes: Tasks 4 to 11.
- Produces:
  - `measureLatency(opts: { iterations: number; warmup: number; ledgerDir: string }): Promise<LatencyReport>`; `LatencyReport = { core: { p50Ms; p99Ms; meanMs }; proxy: { p50Ms; p99Ms; meanMs }; python?: {...}; iterations; machine: { node: string; cpu: string; os: string } }`. Core overhead = guarded `Guard.run` on SQLite WAL file minus direct call of the same no-op; proxy overhead = guarded tool via in-process proxy minus pass tool via the same proxy. 5_000 iterations after 500 warm-up.
  - `runBenchMatrix(opts: { agents: AgentKind[]; paths: ('api' | 'browser')[]; runs: number }): Promise<RunRecord[]>` (browser path uses real `@playwright/mcp` and `bench/src/browser-agent.ts`, a scripted browser agent with naive retries)
  - Real agents: `claudeAgentSdkAgent()` and `openAiAgent()` are external-agent commands that run only when `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are set; otherwise `main.ts` prints `skipped: <AGENT> needs <KEY>` and RESULTS.md lists them under "Not run".
  - `renderResults(input: { latency: LatencyReport; records: RunRecord[]; notRun: string[]; generatedAt: string; command: string }): string`
  - Commands: `npm run bench` (deterministic API path, scripted agents, 3 runs per cell, latency), `npm run bench:browser`, `npm run bench:real` (requires keys and `--confirm-spend`).

RESULTS.md layout: one-command reproduction line; guard overhead table (p50, p99, mean; target under 5 ms); results tables per path and agent with duplicate-effect rate and missing-effect rate, with and without the guard, and run counts; a "Not run" section listing real-model runs with the reason; a "Failures" section that lists every guarded duplicate or missing effect (empty only if there were none); machine and versions. No numbers that were not measured by this run.

- [ ] **Step 1: Write failing tests:** `renderResults includes the overhead table, every cell with run counts, the Not run section and the Failures section`, `a guarded duplicate appears under Failures`, `real agents are skipped without keys and never spawn` (assert the spawn function is not called), `bench:real refuses without --confirm-spend`.
- [ ] **Step 2: Run** `npx vitest run -r bench`, expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, expect PASS. Then run `npm run bench` and `npm run bench:browser` and commit the generated `RESULTS.md`. Record the measured overhead. If overhead p50 is 5 ms or more, profile and fix before continuing (likely candidates: per-call statement preparation, fsync settings).
- [ ] **Step 5: Commit** `bench: latency and chaos matrix harness with generated RESULTS.md`.

## Task 14: Docs, README, release metadata and launch drafts

**Files:**
- Create: `README.md`, `docs/getting-started.md`, `docs/how-it-works.md`, `docs/mcp-proxy.md`, `docs/browser.md`, `docs/configuration.md`, `docs/typescript.md`, `docs/python.md`, `docs/claude-agent-sdk.md`, `docs/chaos.md`, `docs/ci.md`, `docs/ledger.md` (links `spec/ledger-v1.md`), `docs/faq.md`, `llms.txt`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `python/README.md`, `packages/agent-once/README.md` (copy of root README at pack time via a `prepack` script), `docs/launch/show-hn.md`, `docs/launch/dev-to.md`, `docs/launch/reddit.md`, `docs/launch/x-thread.md`
- Modify: `packages/agent-once/package.json` (description, keywords, repository `github:ajibadedapo/agent-once`, homepage, bugs, license, files, `publishConfig.provenance: true`), `python/pyproject.toml` (description, keywords, classifiers, urls)
- Test: `scripts/check-docs.test.mjs`

**Interfaces:**
- Consumes: everything above. Numbers come only from `RESULTS.md`.

- [ ] **Step 1: Write failing docs checks** in `scripts/check-docs.test.mjs`: `README line 1 is exactly the agreed sentence`, `every relative link in README and docs resolves to a file`, `every code block tagged ts in docs typechecks` (extract to a temp dir and run `tsc --noEmit` against the built package), `README overhead figure equals the one in RESULTS.md`, `no company or employer names anywhere in tracked files` (case-insensitive scan for a fixed list of names).
- [ ] **Step 2: Run** `node --test scripts/check-docs.test.mjs`, expect FAIL.
- [ ] **Step 3: Write the docs.** README order: first line; one-paragraph explanation; 60-second quick start (`claude mcp add playwright -- npx agent-once mcp -- npx @playwright/mcp@latest`, and the JSON snippet for Claude Desktop and Cursor); what the guarantee is, in the verbatim wording; what it cannot see (browser to remote site, MCP has no idempotency field); results table excerpt from RESULTS.md with a link; TypeScript and Python snippets; chaos and CI; comparison paragraph (agent-once is a proxy plus chaos suite for any MCP client and browser agents; libraries such as frogscooper/once wrap Python functions; Temporal owns durable execution); licence. External statistics (UndoBench, arXiv, npm downloads) go only into `docs/launch/*` drafts, each marked `Re-verify before posting:` with the source. Keywords and topics from the design: idempotency, exactly-once, double charge, fault injection, chaos engineering, browser agent, computer use, mcp, agent-testing.
- [ ] **Step 4: Release prep (no publishing):** `npm pack --dry-run -w agent-once` and `cd python && uv build`; check the tarball and wheel contents (no tests, no fixtures over 100 KB, licence included); `npx --yes publint` on the package.
- [ ] **Step 5: Run** `node --test scripts/check-docs.test.mjs` and the style checks, expect PASS.
- [ ] **Step 6: Commit** `docs: README, guides, security policy, launch drafts and release metadata`.

## After the final whole-branch review (integrating session, not a task subagent)

Gate: all tests green (TS, Python, interop, chaos, browser), final review findings fixed. Then, per Hammed's approval of 31 Oct 2026:
1. `gh repo create ajibadedapo/agent-once --public --source . --push --description "Stop your AI agent from charging, booking or sending twice."`, then set topics with `gh repo edit --add-topic` for each design keyword (as GitHub topics: idempotency, exactly-once, double-charge, fault-injection, chaos-engineering, browser-agent, computer-use, mcp, agent-testing) and confirm the Apache 2.0 licence is detected.
2. Prepare releases without publishing: version `0.1.0`, `npm pack` artefact and `uv build` artefacts in `dist/`; report the two commands Hammed runs (`npm publish ./packages/agent-once --access public --otp <code>` and `uv publish python/dist/*` or `twine upload python/dist/*`), noting provenance attestations come from the tag-triggered release workflow.
3. Do not run paid real-model benchmarks; report an estimated cost.
4. Do not post anywhere; launch drafts stay in `docs/launch/`.
