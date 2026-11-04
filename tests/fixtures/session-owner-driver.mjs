import { DatabaseSync } from "node:sqlite";

// An isolated fixture DB supplied by the parent test, never the application DATA_DIR.
const db = new DatabaseSync(process.env.AFFINITY_TEST_DB);
db.exec("PRAGMA busy_timeout = 5000");
const adapter = {
  get: (sql, params) => db.prepare(sql).get(...params),
  run: (sql, params) => db.prepare(sql).run(...params),
};
export const getAdapter = async () => adapter;
export const resolveProviderId = (provider) => provider;
export const close = () => db.close();
