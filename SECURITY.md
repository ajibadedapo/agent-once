# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting: open a draft advisory at <https://github.com/ajibadedapo/agent-once/security/advisories/new>. Do not open a public issue, pull request or discussion for a vulnerability.

Include the affected version, how to reproduce it, and what an attacker gains. A minimal MCP server or config that shows the problem is the most useful thing you can send. This is a personal project maintained by one person: I aim to acknowledge a report within a week, agree a fix and disclosure date with you, and credit you in the advisory unless you prefer otherwise.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |

Fixes go into the latest release. Releases published by the release workflow (from a `v*` tag on `main`) carry npm provenance and PyPI attestations. A release published by hand from a workstation, such as the first one, does not.

## No telemetry

agent-once sends no telemetry, analytics or crash reports. The only network calls it makes are to the MCP server it wraps (over stdio, as a child process), to an approval webhook you configure, and, in the chaos suite, to the local chaos targets it starts. The npm package `agent-once` and the PyPI package `once-guard` have no install scripts.

## Threat model notes

agent-once is a local guard against duplicate side effects. It runs with the same privileges as the MCP client that starts it and does not sandbox the server it wraps.

- **The ledger holds tool data.** `~/.agent-once/ledger.db` (or `$AGENT_ONCE_HOME`) stores each guarded call's arguments, its result (up to 256 KiB) and values captured from pages. Arguments can include email bodies, addresses or anything else the agent sends. Set `ledger.storeArgs` to `false` to store argument hashes only; results are still stored so they can be replayed. Protect the directory like any other application data, and keep it out of backups you share. The JSONL evidence file holds decisions, states, tools, session keys, idempotency keys and error messages, but not arguments, results or captured values.
- **Anyone who can write the ledger can resolve actions.** `agent-once resolve` and the ledger file trust the local user. Processes that share a ledger path share their history.
- **Webhook secret.** The approval webhook secret is read from the environment variable named by `approvalWebhook.secretEnv`, never from the config file, and the proxy refuses to start if it is missing. Requests are signed with `X-Agent-Once-Signature: sha256=<HMAC-SHA256 of the body>`; verify it with a constant-time comparison before trusting an answer. The request body contains the tool arguments. Redirects are not followed, the answer is capped at 4 KiB, and anything other than a well-formed answer counts as unresolved, so the action stays blocked.
- **Annotations are untrusted hints.** MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) come from the server. A buggy or hostile server can mark a destructive tool read-only, and agent-once then passes it. Tools without annotations are guarded. Pin `policy` in the config for tools whose behaviour you know, and only wrap servers you trust to run on your machine.
- **Page text is untrusted.** In browser mode, labels and markers come from page snapshots, which the site controls. A page can make a click look like a non-side-effect (or the reverse) by its wording. Read-back steps are fixed in your config, and `{{origin}}` is the origin of the page URL the browser server reports (the snapshot header or the navigate call). The page cannot write that header through its body text, but the browser server can add text from the transacting site around it (a dialog message, for example), so treat `{{origin}}` and `page_url` as coming from the site you are transacting with, not as verified.
- **Scripts are checked by their text.** `browser_evaluate`, `evaluate_script` and `browser_run_code_unsafe` are guarded only when the code text visibly clicks, submits, dispatches an event, or makes a request; side-effect words in the text only choose the class. An obfuscated or indirect script (string building, `eval`, renamed calls, code loaded from a file) passes unguarded. Pin `"policy": "guard"` for these tools under `tools` in the config if the agent may run scripts you cannot read.
- **The agent is not trusted with money.** The agent can resolve only `standard` actions through `agent_once_resolve`; money and irreversible actions need a person, the webhook or a reconciler. An agent could still answer wrongly about a `standard` action. Set `exposeResolveTool` to `false` if that matters for your tools.
- **The client chooses the session.** Session and intent keys in `_meta` come from the MCP client. They scope deduplication; they are not an authentication mechanism.
- **Not a guarantee against the network.** agent-once cannot see retries below the MCP layer, such as a browser re-sending a form POST after a connection reset. See the known limitation in [RESULTS.md](RESULTS.md#known-limitations).
