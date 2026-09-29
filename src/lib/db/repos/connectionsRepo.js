import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const OPTIONAL_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount", "idToken", "lastRefreshAt",
];

const MODEL_LOCK_PREFIX = "modelLock_";
const PORTAL_DELETION_SCOPE = "portalDeletedExternalIds";

function withoutPortalIdentity(data) {
  if (!data.providerSpecificData || typeof data.providerSpecificData !== "object") return data;
  const { portalExternalId, portalTokenVersion, ...providerSpecificData } = data.providerSpecificData;
  return { ...data, providerSpecificData };
}

function resetHealthStateOnActivation(existing, patch) {
  if (patch?.testStatus !== "active") return patch;

  const normalized = {
    ...patch,
    testStatus: "active",
    lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : null,
    lastErrorAt: Object.hasOwn(patch, "lastErrorAt") ? patch.lastErrorAt : null,
    errorCode: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
  };

  for (const key of Object.keys(existing || {})) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) normalized[key] = null;
  }

  return normalized;
}

function rowToConn(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, c) {
  const r = connToRow(c);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.provider, r.authType, r.name, r.email, r.priority, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

function deriveConnectionName(data, fallbackName) {
  if (data.provider === "github") {
    return data.providerSpecificData?.githubLogin
      || data.providerSpecificData?.githubEmail
      || data.email
      || data.providerSpecificData?.githubName
      || fallbackName;
  }
  return fallbackName;
}

export async function getProviderConnections(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.provider) { where.push("provider = ?"); params.push(filter.provider); }
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  const sql = `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const rows = db.all(sql, params);
  const list = rows.map(rowToConn);
  list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return list;
}

export async function getProviderConnectionById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
  return rowToConn(row);
}

// Internal sync reorder — must be called INSIDE a transaction.
//
// Normalizes priorities to a contiguous 1..N after a DELETE or an explicit
// reorder, so gaps don't accumulate over time.
//
// Deliberately NOT called on insert: a new connection already gets
// MAX(priority)+1, which sorts after every existing row, so the order is
// identical with or without the rewrite. Skipping it there is what makes
// import O(1) per key instead of O(pool) — see createProviderConnection.
function reorderInTx(db, providerId) {
  const list = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]).map(rowToConn);
  list.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  list.forEach((c, i) => {
    const want = i + 1;
    if ((c.priority || 0) !== want) {
      db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [want, c.id]);
    }
  });
}

export function createProviderConnectionInTransaction(db, data, { deduplicate = true, portalSync = false } = {}) {
  data = portalSync ? data : withoutPortalIdentity(data);
  const now = new Date().toISOString();

  const isApikey = data.authType === "apikey" && !!data.name;
  const all = isApikey
    ? db.all(
        `SELECT * FROM providerConnections WHERE provider = ? AND authType = ? AND name = ?`,
        [data.provider, "apikey", data.name]
      ).map(rowToConn)
    : db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);
  const poolSize = isApikey
    ? db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [data.provider])?.n ?? all.length
    : all.length;

  let existing = null;
  if (deduplicate && data.authType === "oauth" && data.email) {
    const incomingUsername = data.providerSpecificData?.username;
    const incomingWs = data.providerSpecificData?.chatgptAccountId;
    existing = all.find(c => {
      if (c.authType !== "oauth" || c.email !== data.email) return false;
      // Portal-managed credentials have their own external identity and must
      // never be claimed by a direct OAuth login for the same email/account.
      if (c.providerSpecificData?.portalExternalId) return false;

      // Codex/OpenAI can issue multiple OAuth grants for the same email.
      // Refresh tokens are rotated single-use; collapsing a new login onto an
      // existing bare-email row overwrites the first account's token pair and
      // makes it look "invalid" after adding a second account. Only update an
      // existing Codex row when both rows expose the same ChatGPT account ID.
      if (data.provider === "codex") {
        const existingWs = c.providerSpecificData?.chatgptAccountId;
        return !!incomingWs && !!existingWs && incomingWs === existingWs;
      }

      // Workspace providers use workspace ID when both sides have it
      const existingWs = c.providerSpecificData?.chatgptAccountId;
      if (incomingWs && existingWs) return incomingWs === existingWs;
      if (incomingWs && !existingWs) return false;
      if (!incomingWs && existingWs) return false;
      // Non-workspace providers: match on (email + username) so cross-IdP
      // accounts don't overwrite each other. Require username on both sides
      // — if only one side has it, treat as a distinct identity rather than
      // collapsing onto the bare-email fallback (which would re-introduce
      // the cross-IdP overwrite).
      const existingUsername = c.providerSpecificData?.username;
      if (incomingUsername && existingUsername) {
        return incomingUsername === existingUsername;
      }
      if (incomingUsername || existingUsername) return false;
      return true;
    });
  } else if (deduplicate && data.authType === "apikey" && data.name) {
    existing = all.find(c => c.authType === "apikey" && c.name === data.name);
  }
  // access_token: never dedup — user manages duplicates manually

  if (existing) {
    if (data.allowOverwrite === false) {
      const err = new Error(
        `A connection named "${existing.name}" already exists for provider "${data.provider}". ` +
        `Pass allowOverwrite: true to replace it.`
      );
      err.code = "PROVIDER_NAME_CONFLICT";
      err.existingId = existing.id;
      err.existingName = existing.name;
      throw err;
    }
    const normalized = resetHealthStateOnActivation(existing, data);
    const merged = { ...existing, ...normalized, updatedAt: now };
    upsert(db, merged);
    return merged;
  }

  let connectionName = data.name || null;
  if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
    connectionName = deriveConnectionName(data, data.email || `Account ${poolSize + 1}`);
  }
  let connectionPriority = data.priority;
  if (!connectionPriority) {
    const maxRow = db.get(`SELECT MAX(priority) AS m FROM providerConnections WHERE provider = ?`, [data.provider]);
    connectionPriority = (maxRow?.m || 0) + 1;
  }

  const conn = {
    id: uuidv4(),
    provider: data.provider,
    authType: data.authType || "oauth",
    name: connectionName,
    priority: connectionPriority,
    isActive: data.isActive !== undefined ? data.isActive : true,
    createdAt: now,
    updatedAt: now,
  };
  for (const f of OPTIONAL_FIELDS) {
    if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
  }
  if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
    conn.providerSpecificData = data.providerSpecificData;
  }
  if (data.email !== undefined) conn.email = data.email;

  upsert(db, conn);
  return conn;
}

export async function createProviderConnection(data, options = {}) {
  data = withoutPortalIdentity(data);
  const db = await getAdapter();
  if (options.shouldCommit && !options.shouldCommit()) return null;
  const now = new Date().toISOString();
  let result;

  db.transaction(() => {
    if (options.shouldCommit && !options.shouldCommit()) { result = null; return; }
    // apikey connections are deduped by name and need only the current max
    // priority, so query for those directly instead of loading the whole pool
    // (O(pool) per key — the other half of the import cost in #4311). The oauth
    // branch below still scans, because its identity rules compare fields
    // inside providerSpecificData and have no single-column equivalent.
    const isApikey = data.authType === "apikey" && !!data.name;
    const all = isApikey
      ? db.all(
          `SELECT * FROM providerConnections WHERE provider = ? AND authType = ? AND name = ?`,
          [data.provider, "apikey", data.name]
        ).map(rowToConn)
      : db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);
    const poolSize = isApikey
      ? db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [data.provider])?.n ?? all.length
      : all.length;

    let existing = null;
    if (data.authType === "oauth" && data.email) {
      const incomingUsername = data.providerSpecificData?.username;
      const incomingWs = data.providerSpecificData?.chatgptAccountId;
      existing = all.find(c => {
        if (c.authType !== "oauth" || c.email !== data.email) return false;
        if (c.providerSpecificData?.portalExternalId) return false;

        // Codex/OpenAI can issue multiple OAuth grants for the same email.
        // Refresh tokens are rotated single-use; collapsing a new login onto an
        // existing bare-email row overwrites the first account's token pair and
        // makes it look "invalid" after adding a second account. Only update an
        // existing Codex row when both rows expose the same ChatGPT account ID.
        if (data.provider === "codex") {
          const existingWs = c.providerSpecificData?.chatgptAccountId;
          return !!incomingWs && !!existingWs && incomingWs === existingWs;
        }

        // Workspace providers use workspace ID when both sides have it
        const existingWs = c.providerSpecificData?.chatgptAccountId;
        if (incomingWs && existingWs) return incomingWs === existingWs;
        if (incomingWs && !existingWs) return false;
        if (!incomingWs && existingWs) return false;
        // Non-workspace providers: match on (email + username) so cross-IdP
        // accounts don't overwrite each other. Require username on both sides
        // — if only one side has it, treat as a distinct identity rather than
        // collapsing onto the bare-email fallback (which would re-introduce
        // the cross-IdP overwrite).
        const existingUsername = c.providerSpecificData?.username;
        if (incomingUsername && existingUsername) {
          return incomingUsername === existingUsername;
        }
        if (incomingUsername || existingUsername) return false;
        return true;
      });
    } else if (data.authType === "apikey" && data.name) {
      existing = all.find(c => c.authType === "apikey" && c.name === data.name);
    }
    // access_token: never dedup — user manages duplicates manually

    if (existing) {
      // Name collision on an apikey connection used to silently replace the
      // stored apiKey, so a script that reused names ("Key 1", "Key 2", …)
      // destroyed existing pool entries with no 409 and no warning. Callers that
      // genuinely mean "update this one" pass allowOverwrite; everyone else gets
      // a typed error naming the row that would have been replaced. #4311
      if (data.allowOverwrite === false) {
        const err = new Error(
          `A connection named "${existing.name}" already exists for provider "${data.provider}". ` +
          `Pass allowOverwrite: true to replace it.`
        );
        err.code = "PROVIDER_NAME_CONFLICT";
        err.existingId = existing.id;
        err.existingName = existing.name;
        throw err;
      }
      const normalized = resetHealthStateOnActivation(existing, data);
      const merged = { ...existing, ...normalized, updatedAt: now };
      upsert(db, merged);
      result = merged;
      return;
    }

    let connectionName = data.name || null;
    if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
      connectionName = deriveConnectionName(data, data.email || `Account ${poolSize + 1}`);
    }
    let connectionPriority = data.priority;
    if (!connectionPriority) {
      // MAX(priority)+1 in SQL rather than a reduce over the loaded pool: the
      // apikey path no longer has the whole pool in memory, and the aggregate
      // is served by the index instead of a row scan. #4311
      const maxRow = db.get(`SELECT MAX(priority) AS m FROM providerConnections WHERE provider = ?`, [data.provider]);
      connectionPriority = (maxRow?.m || 0) + 1;
    }

    const conn = {
      id: uuidv4(),
      provider: data.provider,
      authType: data.authType || "oauth",
      name: connectionName,
      priority: connectionPriority,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };
    for (const f of OPTIONAL_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      conn.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) conn.email = data.email;

    upsert(db, conn);
    // No reorderInTx here. `conn.priority` is already MAX(priority)+1, so the
    // row sorts last and the resulting order is what reorderInTx would have
    // produced anyway. The rewrite cost ~2N statements per insert — O(pool) —
    // which made a 5k-key import O(n*m): ~25M statements at a 5k pool, and it
    // serialized every parallel writer on the same transaction. #4311
    result = conn;
  });

  return result;
}

// Critical: OAuth refresh token race — atomic merge inside transaction
export async function updateProviderConnection(id, data, options = {}) {
  const db = await getAdapter();
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Request aborted", "AbortError");
  if (options.shouldCommit && !options.shouldCommit()) return null;
  options.beforeCommit?.();
  if (options.shouldCommit && !options.shouldCommit()) return null;
  let result;
  db.transaction(() => {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Request aborted", "AbortError");
    if (options.shouldCommit && !options.shouldCommit()) { result = null; return; }
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) { result = null; return; }
    const existing = rowToConn(row);
    const normalized = resetHealthStateOnActivation(existing, data);
    const portalId = existing.providerSpecificData?.portalExternalId;
    const guarded = portalId ? {
      ...normalized,
      accessToken: existing.accessToken,
      expiresAt: existing.expiresAt,
      refreshToken: undefined,
      providerSpecificData: {
        ...(normalized.providerSpecificData || {}),
        ...existing.providerSpecificData,
        portalExternalId: portalId,
        portalTokenVersion: existing.providerSpecificData.portalTokenVersion,
      },
    } : normalized;
    const merged = { ...existing, ...guarded, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    if (data.priority !== undefined) reorderInTx(db, existing.provider);
    result = merged;
  });
  if (result) options.afterCommit?.(result);
  return result;
}

export async function upsertPortalManagedConnection(externalId, tokenVersion, provider, buildValues) {
  const db = await getAdapter();
  let outcome;

  db.transaction(() => {
    if (db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [PORTAL_DELETION_SCOPE, externalId])) {
      outcome = { status: "deleted" };
      return;
    }
    const rows = db.all(`SELECT * FROM providerConnections`);
    const existing = rows.map(rowToConn).find((connection) =>
      connection.providerSpecificData?.portalExternalId === externalId
    ) || null;
    const currentVersion = existing?.providerSpecificData?.portalTokenVersion || 0;

    if (existing && provider !== existing.provider) {
      outcome = { status: "provider_mismatch", connection: existing, tokenVersion: currentVersion };
      return;
    }
    if (existing && tokenVersion < currentVersion) {
      outcome = { status: "stale", connection: existing, tokenVersion: currentVersion };
      return;
    }
    if (existing && tokenVersion === currentVersion) {
      // A same-version Portal replay may repair terminal health and metadata,
      // but must not replace the current access token or expiry. Portal is the
      // only refresh authority, so a prior router error cannot remain sticky.
      const values = buildValues(existing);
      const healed = {
        ...existing,
        ...resetHealthStateOnActivation(existing, { testStatus: "active" }),
        refreshToken: undefined,
        isActive: values.isActive,
        displayName: values.displayName ?? existing.displayName,
        name: values.name ?? existing.name,
        updatedAt: new Date().toISOString(),
      };
      upsert(db, healed);
      outcome = { status: "unchanged", connection: healed, tokenVersion: currentVersion };
      return;
    }

    const values = buildValues(existing);
    if (existing) {
      // Portal is the sole refresh-token owner. An explicit undefined removes
      // any stale value inherited from an older or incorrectly-classified row.
      const merged = {
        ...existing,
        ...resetHealthStateOnActivation(existing, values),
        refreshToken: undefined,
        updatedAt: new Date().toISOString(),
      };
      upsert(db, merged);
      outcome = { status: "updated", connection: merged, tokenVersion };
      return;
    }

    const connection = createProviderConnectionInTransaction(db, values, { deduplicate: false, portalSync: true });
    outcome = { status: "created", connection, tokenVersion };
  });

  return outcome;
}

export async function deletePortalManagedConnection(externalId) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    // The Portal owns this identity forever. Tombstone and row deletion share
    // one transaction so an in-flight PUT cannot recreate a revoked credential.
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, 'deleted')
       ON CONFLICT(scope, key) DO NOTHING`,
      [PORTAL_DELETION_SCOPE, externalId]
    );
    const connections = db.all(`SELECT * FROM providerConnections`).map(rowToConn).filter((row) =>
      row.providerSpecificData?.portalExternalId === externalId
    );
    if (connections.length === 0) return;
    for (const connection of connections) {
      db.run(`DELETE FROM providerConnections WHERE id = ?`, [connection.id]);
    }
    for (const provider of new Set(connections.map((connection) => connection.provider))) {
      reorderInTx(db, provider);
    }
    deleted = true;
  });
  return deleted;
}

export async function deleteProviderConnection(id) {
  const db = await getAdapter();
  let ok = false;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    const externalId = rowToConn(row).providerSpecificData?.portalExternalId;
    if (externalId) {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, 'deleted')
         ON CONFLICT(scope, key) DO NOTHING`,
        [PORTAL_DELETION_SCOPE, externalId]
      );
    }
    db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
    reorderInTx(db, row.provider);
    ok = true;
  });
  return ok;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getAdapter();
  let count = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]);
    for (const row of rows) {
      const externalId = rowToConn(row).providerSpecificData?.portalExternalId;
      if (!externalId) continue;
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, 'deleted')
         ON CONFLICT(scope, key) DO NOTHING`,
        [PORTAL_DELETION_SCOPE, externalId]
      );
    }
    db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId]);
    count = rows.length;
  });
  return count;
}

export async function reorderProviderConnections(providerId) {
  const db = await getAdapter();
  db.transaction(() => reorderInTx(db, providerId));
}

export async function cleanupProviderConnections() {
  const db = await getAdapter();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM providerConnections`);
    for (const row of rows) {
      const conn = rowToConn(row);
      let dirty = false;
      for (const f of fieldsToCheck) {
        if (conn[f] === null || conn[f] === undefined) {
          if (f in conn) { delete conn[f]; cleaned++; dirty = true; }
        }
      }
      if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
        delete conn.providerSpecificData;
        cleaned++;
        dirty = true;
      }
      if (dirty) upsert(db, conn);
    }
  });
  return cleaned;
}
