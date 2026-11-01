# AZO-1070: semantic header snapshots

## Scope and provenance

Test-only follow-up to PR19, starting head `381cd31d7cb6bff577f41d9b1af36556b366e387`, upstream v0.5.112 `1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d`. Production source, registry, credentials, package dependencies and runtime headers unchanged. No merge, release or deploy.

`tests/translator/header-snapshot.js` validates raw values before replacing exact provider-specific keys. It runs outside the golden test's exception-to-string wrapper, so a semantic failure cannot become an accepted `THROW` snapshot. Unrelated provider/header values remain visible to the existing golden test. Existing credential, Kimi timestamp/device-name and MiniMax session normalization is unchanged.

| Provider | Exact dynamic keys | Required invariant before normalization | Source |
|---|---|---|---|
| cline, clinepass | User-Agent, X-CLIENT-VERSION, X-CORE-VERSION, X-PLATFORM-VERSION | Own string fields; User-Agent exactly `9Router/${package.json.version}`; client/core equal package version; platform version equals `process.version` | `open-sse/shared/clineAuth.js`, `open-sse/executors/default.js` |
| kimi | X-Msh-Version | Own string equals package version | `open-sse/config/appConstants.js:buildKimiHeaders` |
| codebuddy-cn, codebuddy-intl | X-Request-ID, X-Conversation-ID, X-Conversation-Request-ID, X-Conversation-Message-ID | Own strings, UUIDv4 shape/variant; request/message correlations equal request UUID; conversation differs | `open-sse/executors/default.js:HEADER_HOOKS.codebuddyHeaders` |

## Twelve individual snapshot decisions

Each row below accepts two separate entries, reviewed against its own registry definition plus `DefaultExecutor.buildUrl`, `resolveAuthDescriptor` and `buildHeaders`. URL entries keep the literal base URL for both stream flags. Header entries use this specific default-executor fixture: apiKey/oauth bearer fallback, JSON Content-Type, Accept only for stream. These are not claims about specialized web executors or successful live authentication. No live calls were made.

| Provider | URL entry decision | Header entry decision |
|---|---|---|
| chatgpt-web | Accept `https://chatgpt.com` from its transport, no suffix/model substitution | Accept three fixture modes; no transport headers/auth descriptor/hooks, so default Bearer and stream Accept |
| deepseek-web | Accept `https://chat.deepseek.com/api/v0/chat/completion` from its transport | Accept three fixture modes; default Bearer and stream Accept, not a cookie-login contract |
| gemini-web | Accept `https://gemini.google.com/app`; format is openai, not Gemini API format | Accept three fixture modes; default Bearer and stream Accept, no Gemini API header inference |
| muse-web | Accept `https://muse.ai`; distinct from Muse API provider | Accept three fixture modes; no Muse API subscription hook on this provider |
| sensenova | Accept `https://token.sensenova.cn/v1/chat/completions`; validateUrl is not buildUrl | Accept three fixture modes; openai format default and Bearer fallback |
| uc-web | Accept `https://internal.chatuncensored.ai`; no appended chat path in generic branch | Accept three fixture modes; default Bearer and stream Accept, not specialized media execution |

Entries were hand-authored from reviewed source, never copied from scratch snapshots. Focused sandbox run matched all 164 committed keys, including all twelve new entries. Exactly five pre-existing keys changed: cline/clinepass version placeholders, kimi version placeholder, codebuddy-cn/int'l UUID placeholders. No snapshot key removed.

## TDD and verification

Node `22.23.4`, Vitest `4.1.12`, existing offline kit. Dependency manifest SHA-256 `70efb0fd2bf5a8c7586f53046795d175a60d7871ff373d7f5d97f178dd4ec5a5`, Node manifest `c84627090aaa52c04126546f1611d0a2ef84f9c15ddb07f0f2eccedfda35f1b1`; rehashed 37,059 dependency files and 4,750 toolchain files.

Every invocation uses foreground Bubblewrap, no external network, empty explicit environment, scratch-local HOME/tmp/cache; source/deps/toolchain/harness/system read-only, only scratch writable. Final-mount probes passed before target launch. Envelope: scratch 8 GiB, CPU 0–3, AS 32 GiB/process, Node heap option 4 GiB, CPU 420 s/process, NPROC 512/real UID, FSIZE 128 MiB, NOFILE 1024, inner 390 s, outer 510 s TERM +20 s KILL. These are not aggregate cgroup or tamper-proof heap guarantees. No dependency install, live data, credentials or host policy changes.

Common command inside sandbox:

```text
/toolchain/bin/node --disable-wasm-trap-handler /source/tests/node_modules/vitest/vitest.mjs run --config /scratch/vitest.config.mjs <files>
```

Scratch config inherits `tests/vitest.config.js`, uses one fork worker, isolation, JSON reporter and scratch-only snapshots. Parent retains counts, hashes and field-only semantic-failure classifications, not raw output.

| Check | Files | Exit | Result |
|---|---|---:|---|
| RED identity helper | translator/header-snapshot.test.js | 1 | 105 tests: 104 assertion failures, 1 pass; no import/config error or snapshot side effects |
| GREEN guarded helper | Same 105 semantic cases | 0 | 105/105 pass; 0 fail/skip/todo; snapshots unchanged |
| Focused patched source | Header semantic + golden + cline-auth, codebuddy-channel-headers, kimi-responses-transport, azox-prefill-cache, combo-import-export, portal-refresh-exclusion, request-details-redaction | 0 | 378/378 pass; 164 snapshots matched; 0 added/updated/unmatched; zero scratch snapshot changes |
| AZOX regression list plus header suites | Existing 24-file contract list below + semantic/golden | 0 | 572/572 pass, 0 fail/skip/todo; 164 snapshots matched, zero snapshot changes |
| Delete X-CORE-VERSION in disposable production copy | Golden file | 1 | 162 pass, 2 semantic guard failures; no snapshot changes |
| Wrong X-CLIENT-VERSION in disposable production copy | Golden file | 1 | 162 pass, 2 semantic guard failures; no snapshot changes |
| Malformed X-Request-ID in disposable production copy | Golden file | 1 | 162 pass, 2 semantic guard failures; no snapshot changes |
| Break message/request UUID correlation in disposable production copy | Golden file | 1 | 162 pass, 2 semantic guard failures; no snapshot changes |

Semantic cases cover each normalized field missing/wrong type, each version relationship, malformed/v1/wrong-variant UUIDs, each request/message correlation, conversation collision, unrelated values, valid version changes, input immutability and real executor apiKey/oauth × stream/nonstream modes.

24-file unchanged regression list:

```text
unit/api-key-entropy.test.js
unit/azox-prefill-cache.test.js
unit/azox-prefill-fallback.test.js
unit/azox-prefill-passthrough.test.js
unit/chat-core-error-abort.test.js
unit/combo-empty-failover.test.js
unit/combo-import-export.test.js
unit/combo-import-integration.test.js
unit/combo-import-storage.test.js
unit/gateway-monitoring-handlers.test.js
unit/headroom-chat-core.test.js
unit/oauth-transport-bounds.test.js
unit/portal-refresh-exclusion.test.js
unit/portal-sync-atomic.test.js
unit/portal-sync-route.test.js
unit/responses-abort-terminal.test.js
unit/security-audit.test.js
unit/sqljs-backup-host-file.test.js
unit/streaming-html-account-health.test.js
unit/streaming-html-bounds.test.js
unit/streaming-html-fallback.test.js
unit/upstream-error-bounds.test.js
unit/usage-api-key-attribution.test.js
unit/usage-stats-output-redaction.test.js
```

## Limits and execution deviations

- Full suites were not rerun. AZO-1069 historical upstream 4238 pass/30 fail/98 skip/1 todo; candidate 4447 pass/32 fail/98 skip/1 todo, both exit1. Three upstream prefill conflicts remain unresolved. These focused green checks do not qualify the full upgrade, security review, artifact or rollout.
- Initial RED launcher used unsupported `--ci`, produced no Vitest JSON, and consumed one conservative invocation; corrected RED is separate verified evidence.
- A failed source-export assertion was not shell-gated and an old focused source ran without a new pre-launch reservation. This accounting-order defect is recorded, not retroactively approved; actual trial/integration consumption was charged. That stale result is excluded from patched-source evidence. Later launches use fail-fast export checks and durable pre-launch reservations.
- One corrected focused label was initially rejected by launcher before sandbox start; the same unconsumed reservation was retained, then consumed once on corrected launch.
- Diagnostic golden run auto-added twelve scratch keys despite `update:false` and `didUpdate:false`; none were promoted. Final hand-authored snapshots show zero side effects.
- Manager self-review is not independent review. New PR commits invalidate previous exact-head acceptance. PR19 remains draft; no merge/release/deploy claim.
