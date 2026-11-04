# Durable session account ownership

Requests with a session key bind to one account per canonical provider and calling API key. The `kv` table stores only a SHA-256 identity, account connection ID, version and creation time; it does not store raw session IDs, API keys or ciphertext.

## Routing contract

- The first plaintext turn claims an owner with SQLite `INSERT ... ON CONFLICT DO NOTHING`. Concurrent workers re-read and use the persisted winner, including that account's credentials and proxy settings.
- Native SQLite is required for session-bound routing (`bun:sqlite`, `better-sqlite3` or `node:sqlite`). The `sql.js` fallback uses independent in-memory snapshots and deferred persistence, so session-bound requests fail closed rather than claim cross-process durability. Requests without session keys are unaffected.
- `NINEROUTER_SESSION_AFFINITY_TTL_MS` and `sessionAffinityTtlMs` control the renewable lease only. Expiry and TTL=0 do not release ownership.
- Existing legacy `sessionAccountAffinity` rows are promoted lazily, including expired rows. Already-deleted legacy mappings cannot be reconstructed.
- Disabled, missing, banned, expired, locked, cooling-down or failed owners are not replaced. Temporary failures return HTTP 409 `session_affinity_unavailable` and instruct the caller to retry the same session after recovery.
- Encrypted continuations require an existing trustworthy owner and an explicit provider/model target. Unknown or malformed mappings fail closed; repair from a trusted backup or start a new conversation without old encrypted content. Never guess a replacement account.
- Session-keyed fallback combos do not fall through to another model/provider, and single-model capacity adapters do not silently replace session owners. Fusion is not a single-owner conversation; encrypted requests targeting combos/fusion are rejected.

## Retention and recovery

Owner rows and unpromoted legacy evidence deliberately have no automatic expiry or garbage collection. A finite lease must not erase the only evidence of the account that issued ciphertext. Storage grows with distinct session identities; monitor DB size and include the SQLite DB in backups. Do not prune either ownership scope independently of the conversation data it protects.

Do not delete a malformed row to make routing resume: that can bind old conversation state to a different account. Restore the original mapping from a trusted backup, or use a new session key without encrypted content from the old conversation. Restoring only part of a DB or mixing old and new router versions against the same DB weakens these guarantees; upgrade all workers and retain a consistent DB backup.

## Tests

Run from `tests/`:

```sh
npx vitest run unit/session-affinity.test.js unit/session-affinity-chat.test.js unit/session-owner-sqlite.test.js unit/combo-routing.test.js
```

Coverage includes lease expiry, TTL=0, legacy promotion, corrupt evidence, owner outages/recovery, no account/model fallback, real SQLite reopen, independent-process first-claim arbitration and rejection of `sql.js` session routing.
