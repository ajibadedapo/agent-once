# agent-once ledger format, version 1

This document is the contract shared by every agent-once implementation (the TypeScript package `agent-once` and the Python package `once-guard`, import name `agent_once`). Two implementations that follow it compute the same identities, read and write the same ledger file, and make the same decisions. The shared test vectors in `spec/vectors/` are normative: an implementation conforms only if it passes all of them.

The guarantee: at most once by default, exactly once wherever a reconciler can confirm the outcome.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Conventions

- Times are integer milliseconds since the Unix epoch (UTC). Durations are integer milliseconds.
- A time `t` is within a window of length `w` that started at `s` when `t < s + w`. Exactly at `s + w` is outside the window.
- An event is expired when `expires_at_ms <= now`. Exactly at `expires_at_ms` is expired.
- Hex digests are lowercase.

Defaults (both implementations use the same values):

| Setting | Default |
|---|---|
| Retry window | 120 000 ms (120 s) |
| Ledger expiry | 86 400 000 ms (24 h) |
| Settle window | 10 000 ms (10 s) |
| Stored result cap | 262 144 bytes (256 KiB) of UTF-8 JSON |
| Ledger home | `$AGENT_ONCE_HOME`, else `~/.agent-once/` |
| Ledger file | `<home>/ledger.db` |
| Evidence file | `<home>/events.jsonl` |

## 2. Canonical JSON

All hashing uses the JSON Canonicalization Scheme, RFC 8785 (JCS):

- Object members are sorted by key, comparing keys as arrays of UTF-16 code units (not code points, not UTF-8 bytes). A key starting with a supplementary character (a surrogate pair, code units `0xD800` to `0xDFFF`) therefore sorts before a key starting with a code unit at or above `0xE000`, such as `U+FF61`, although its code point is higher.
- No whitespace between tokens.
- Strings are emitted with only these escapes: `\"`, `\\`, `\b`, `\t`, `\n`, `\f`, `\r`, and `\u00XX` (lowercase hex) for every other code point below `U+0020`. Everything else, including `/`, `U+007F`, non-ASCII characters, `U+2028` and `U+2029`, is emitted literally.
- Numbers are IEEE 754 doubles serialized with the ECMAScript `Number.prototype.toString` algorithm: integral values have no fraction (`1.0` becomes `1`), `-0` becomes `0`, exponent form is used from `1e21` upwards and below `1e-6` (`1e+21`, `1e-7`), and the shortest round-tripping digit string is used.
- `NaN`, `Infinity` and `-Infinity` cannot be represented. Canonicalization MUST fail with a typed canonicalization error that names the path of the offending value. A guarded call whose arguments fail to canonicalize is reported as an error and MUST NOT be dispatched or written to the ledger.

The canonical text is encoded as UTF-8 before hashing.

## 3. Identity

### 3.1 Projected arguments

`projected_args` is computed from the tool call arguments (a JSON object) in this order:

1. Remove volatile keys at any depth, including inside objects nested in arrays. The match is exact and case-sensitive. The default volatile keys are `timestamp`, `ts`, `nonce`, `request_id`, `requestId`, `idempotency_key`, `idempotencyKey`, `trace_id`, `traceId`, `_meta`. The browser profile adds `target`, `ref`, `uid`, `pageId`, `from_uid`, `to_uid`, `slowly`, `includeSnapshot`.
2. Apply the tool's identity rule, if any, to the top-level keys only:
   - `{"include": [k1, k2, ...]}` keeps only the listed keys that are present.
   - `{"exclude": [k1, k2, ...]}` removes the listed keys.
3. Browser profile only: set `page_url` and `label`, replacing any argument keys with the same names.
   - `page_url` is the origin followed by the path of the current page URL, as defined by the WHATWG URL Standard (`url.origin + url.pathname`). Query, fragment and credentials are dropped, scheme and host are lowercase, a default port (80 for http, 443 for https) is omitted and an empty path is `/`.
   - `label` is the resolved human-readable label of the element acted on.

### 3.2 Intent hash

```
intent_hash = hex(SHA-256(JCS(["agent-once/v1", session_key, tool, projected_args])))
```

When the caller supplies an explicit intent key (a string), the arguments are ignored:

```
intent_hash = hex(SHA-256(JCS(["agent-once/v1/intent", session_key, tool, intent_key])))
```

### 3.3 Action id

Each attempt to perform an intent is an occurrence, numbered from 0.

```
action_id = "ao_" + first 24 hex characters of hex(SHA-256(JCS([intent_hash, occurrence])))
```

The action id is what the guard forwards to upstream services as an idempotency key.

### 3.4 Session key

On the MCP proxy path the session key is the first of:

1. `_meta["io.github.ajibadedapo.agent-mandates/mandate-id"]` (explicit)
2. `_meta["io.github.ajibadedapo/agent-once-session"]` (explicit)
3. environment variable `AGENT_ONCE_SESSION` (explicit)
4. `clientInfo.name + ":" + cwd` (default, not explicit)

An explicit intent key on the proxy path comes from `_meta["io.github.ajibadedapo/agent-once-intent"]`. Library callers pass the session key, its explicitness and the intent key directly.

## 4. Storage

### 4.1 File

The ledger is a SQLite database. Every connection MUST set:

```
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

Each decision runs in one `BEGIN IMMEDIATE` transaction: read the latest event for the intent, decide, and, when the decision is execute, append the `intended` event for the new occurrence before committing. Replay and in-doubt decisions append nothing.

### 4.2 Schema

`spec/ledger-v1.sql` is the exact schema. It is applied once, in one transaction, to an empty database, and it writes `meta.schema_version = "1"`.

Opening rules:

- A database without a `meta` table is new: apply the schema.
- A reader MUST refuse to open a ledger whose `schema_version` is greater than the version it knows, with an error that states the version found. It MUST NOT modify such a file.
- An unreadable, corrupt or unwritable ledger is unavailable. Guarded calls fail closed with an "agent-once ledger unavailable" error and are not dispatched. Calls with policy `pass` are unaffected.
- After the schema version check passes, opening deletes rows with `expires_at_ms < now`. Once every event of an intent is pruned, the next call for it decides `new` at occurrence 0.

### 4.3 Events

The `events` table is append-only: rows are never updated, only appended and, once expired, pruned. Columns:

| Column | Meaning |
|---|---|
| `seq` | Monotonic order of appends |
| `action_id`, `intent_hash`, `occurrence` | Identity from section 3 |
| `state` | `intended`, `sent`, `confirmed`, `failed` or `reconciled` |
| `at_ms` | When this event was appended |
| `expires_at_ms` | `at_ms` plus the ledger expiry |
| `session_key`, `session_explicit` | Session key and whether it was explicit (0 or 1) |
| `intent_key_explicit` | 1 when an explicit intent key produced the hash |
| `run_instance` | Identifier of the process run (one per guard instance) |
| `tool`, `tool_class` | Tool name and class: `money`, `irreversible` or `standard` |
| `policy` | `guard` or `block-on-doubt` |
| `args_json` | The original arguments as JSON, or null when argument storage is off |
| `detail_json` | State-specific detail, a JSON object (section 4.4) |

The unique index `events_one_intended` allows one `intended` event per intent and occurrence, so two writers racing for the same occurrence cannot both claim it.

### 4.4 States and detail keys

```
intended -> sent -> confirmed
                 -> failed
intended | sent | failed -> reconciled
```

| State | Meaning | `detail_json` keys |
|---|---|---|
| `intended` | Claimed, not yet dispatched | `captured?` (string) |
| `sent` | Dispatch started; the outcome is unknown until a later event | `captured?` (string) |
| `confirmed` | The tool returned a success result | `result`, `result_truncated` (boolean), `delivery`: `"delivered"` or `"cancelled"` |
| `failed` | The tool returned an error or the transport failed | `failure_kind`: `"error_result"`, `"transport_error"` or `"not_dispatched"`; `error` (string); `result` (JSON or null) |
| `reconciled` | The outcome was established after doubt | `outcome`: `"happened"` or `"not_happened"`; `resolved_by`: `"reconciler"`, `"agent"`, `"human"` or `"webhook"`; `result` (JSON or null) |

- `captured` is a value read from the environment before dispatch (for example an order reference on the page) for later reconciliation.
- A result whose UTF-8 JSON exceeds the stored result cap is stored as `null` with `result_truncated: true`. A replay of it reports that the effect is confirmed but the result was too large to keep.
- `delivery: "cancelled"` means the effect completed but the caller had gone (for example the client cancelled the request) and never received the result.
- `not_dispatched` means the tool provably did not perform the effect (for example a stale element reference rejected before any action).

### 4.5 Latest event

The latest event for an intent is the event with the highest `seq` among the events of the highest occurrence for that intent hash. Decisions use only this event.

## 5. Decision

`decide` is a pure function of the latest event (or none), the call context `{run_instance, session_explicit, intent_key_explicit, policy}`, `now` and the retry window. The rows are evaluated top to bottom and the first match wins. "Next" is the latest event's occurrence plus 1.

| Latest | Condition | Decision | Reason |
|---|---|---|---|
| none | | execute occurrence 0 | `new` |
| expired (`expires_at_ms <= now`) | | execute next | `expired` |
| `intended` or `sent` | | in doubt | `outcome_unknown` |
| `failed`, `not_dispatched` | | execute next | `not_dispatched` |
| `failed` | policy `block-on-doubt` | in doubt | `failed_block_on_doubt` |
| `failed` | `now < at_ms + window` | in doubt | `failed_within_window` |
| `failed` | otherwise | execute next | `failed_after_window` |
| `confirmed` or `reconciled` happened | intent key explicit | replay | `replay_explicit_intent` |
| `confirmed` or `reconciled` happened | (`delivery` is `cancelled` or state is `reconciled`) and `now < at_ms + window` | replay | `replay_undelivered` |
| `confirmed` or `reconciled` happened | different `run_instance`, session explicit | replay | `replay_rerun_explicit_session` |
| `confirmed` or `reconciled` happened | different `run_instance`, default session, `now < at_ms + window` | replay | `replay_rerun_within_window` |
| `confirmed` or `reconciled` happened | otherwise | execute next | `deliberate_repeat` |
| `reconciled` not happened | | execute next | `reconciled_not_happened` |

"Session explicit" and "intent key explicit" refer to the current call. A replay returns the stored result of the latest event without dispatching. An in-doubt decision refers to the latest event's occurrence.

## 6. In-doubt handling

In-doubt handling belongs to the guard, not to `decide`:

1. Run the tool's reconciler, if any. `happened` is accepted at once. `not_happened` is accepted only when `now - at_ms(sent) >= settle window`; earlier it is treated as unknown with reason `too_soon`. An accepted outcome is appended as a `reconciled` event with `resolved_by: "reconciler"`; `happened` then replays and `not_happened` executes the next occurrence.
2. Otherwise, policy `guard` returns in doubt: the outcome is unknown and the agent may resolve it.
3. Policy `block-on-doubt` (the default for classes `money` and `irreversible`) asks the human resolver chain (elicitation, then webhook). If nobody resolves it, the call is blocked.

Resolution rules:

- An agent may resolve only actions of class `standard`.
- An agent's `not_happened` inside the settle window is refused as `too_soon`, the same rule as for reconcilers.
- Humans and webhooks are authoritative and may resolve any class at any time.

## 7. Test vectors

All vector files are JSON arrays of cases. Every case has a unique `name`.

### 7.1 `vectors/canonical.json`

```
{ "name": string, "input": JSON, "canonical": string }
{ "name": string, "input": JSON, "error": "non_finite" }
```

`canonicalize(input)` MUST equal `canonical`, or fail with the canonicalization error when `error` is `"non_finite"`. JSON cannot express non-finite numbers, so in `error` cases any object of exactly the form `{"$number": "NaN"}`, `{"$number": "Infinity"}` or `{"$number": "-Infinity"}` stands for that number and MUST be substituted before canonicalizing.

Number inputs are written so that every JSON parser reads the intended double: values that are not integers in the source are written with a fraction or an exponent, so Python reads them as `float`. Integer literals such as `9007199254740992` are read as `int` by Python; an implementation MUST serialize such integers as JCS serializes the equal double. Case names of the form `rfc8785_number_<hex>` are the number examples published in RFC 8785 Appendix B, where `<hex>` is the IEEE 754 bit pattern of the input.

### 7.2 `vectors/identity.json`

```
{
  "name": string,
  "session_key": string,
  "tool": string,
  "args": object,
  "identity_rule"?: {"include": [string]} | {"exclude": [string]},
  "browser"?: {"page_url": string, "label": string},
  "intent_key"?: string,
  "projected": object,
  "intent_hash": string,
  "occurrence": integer,
  "action_id": string
}
```

- `browser.page_url` is the raw page URL; its presence selects the browser profile (browser volatile keys plus the `page_url` and `label` step of section 3.1).
- `projected` is `projected_args` from section 3.1. It is computed even when `intent_key` is present, although the hash then ignores it.
- `intent_hash` and `action_id` follow sections 3.2 and 3.3.

The cases use only strings, integers, booleans, null and nested objects or arrays with ASCII keys, so Python's `json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` equals JCS for them. `scripts/gen_identity_vectors.py` regenerates the file; `--check` fails if the file is out of date.

### 7.3 `vectors/decisions.json`

```
{
  "name": string,
  "now_ms": integer,
  "retry_window_ms": integer,
  "expiry_ms": integer,
  "latest": null | {
    "state": string,
    "occurrence": integer,
    "at_ms": integer,
    "expires_at_ms": integer,
    "run_instance": string,
    "detail": object
  },
  "call": {
    "run_instance": string,
    "session_explicit": boolean,
    "intent_key_explicit": boolean,
    "policy": "guard" | "block-on-doubt"
  },
  "expect": {
    "kind": "execute" | "replay" | "in_doubt",
    "occurrence": integer,
    "reason": string
  }
}
```

`decide(latest, now_ms, retry_window_ms, call)` MUST produce `expect.kind` and `expect.reason`. For `execute`, `expect.occurrence` is the occurrence to run; for `replay` and `in_doubt` it is the occurrence of the latest event. `expiry_ms` is the ledger expiry the events were written with (every case has `expires_at_ms = at_ms + expiry_ms`); `decide` reads expiry only from `latest.expires_at_ms`. The cases cover every row of the table in section 5 and the boundaries: exactly at the end of the retry window is outside it, and exactly at `expires_at_ms` is expired.

## 8. Versioning

This is version 1 (`schema_version = "1"`, hash domains `agent-once/v1` and `agent-once/v1/intent`). Any change to identity, canonicalization or the meaning of a stored column requires a new version. Readers refuse versions newer than they know.
