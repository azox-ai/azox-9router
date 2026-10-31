import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import { backupDbLite } from "../../src/lib/db/backup.js";

// SQL.js runs SQLite in memory: an ATTACH-based copy lands in its virtual
// filesystem, so the pre-migration safety backup silently never reaches disk.
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("SQL.js safety backup", () => {
  it("writes unflushed rows to a host file, keeps exact 64-bit integers and omits requestDetails", async () => {
    const adapter = await createSqlJsAdapter(path.join(tempDir("9router-sqljs-src-"), "data.sqlite"));
    try {
      adapter.exec(`CREATE TABLE "odd ""name""" (id INTEGER PRIMARY KEY, big INTEGER, label TEXT, blob BLOB, note TEXT)`);
      adapter.exec(`CREATE TABLE requestDetails (id TEXT PRIMARY KEY, body TEXT)`);
      adapter.exec(`INSERT INTO "odd ""name""" VALUES (1, 9007199254740993, 'first', x'00ff', NULL)`);
      adapter.exec(`INSERT INTO "odd ""name""" VALUES (2, -9223372036854775808, 'second', NULL, 'x')`);
      adapter.exec(`INSERT INTO requestDetails VALUES ('r1', 'large observability row')`);

      const dest = backupDbLite(adapter, tempDir("9router-sqljs-bk-"));

      expect(fs.existsSync(dest)).toBe(true);
      const bak = new Database(dest, { readonly: true });
      try {
        bak.defaultSafeIntegers(true);
        const rows = bak.prepare(`SELECT id, big, typeof(big) AS kind, label, hex(blob) AS blob, note FROM "odd ""name""" ORDER BY id`).all();
        expect(rows).toEqual([
          { id: 1n, big: 9007199254740993n, kind: "integer", label: "first", blob: "00FF", note: null },
          { id: 2n, big: -9223372036854775808n, kind: "integer", label: "second", blob: "", note: "x" },
        ]);
        expect(bak.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='requestDetails'`).get())
          .toBeUndefined();
      } finally {
        bak.close();
      }
    } finally {
      adapter.close();
    }
  });
});
