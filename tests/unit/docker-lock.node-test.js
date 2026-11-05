import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

function installPlan(alterManifest = false) {
  const dir = mkdtempSync(join(tmpdir(), "9router-lock-"));
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (alterManifest) manifest.dependencies.next = "0.0.0";
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    if (existsSync(join(root, "package-lock.json"))) copyFileSync(join(root, "package-lock.json"), join(dir, "package-lock.json"));
    const npm = join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
    return spawnSync(process.execPath, [npm, "ci", "--dry-run", "--offline", "--ignore-scripts",
      "--include=dev", "--include=optional", "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: dir, encoding: "utf8", timeout: 15000,
      env: { PATH: process.env.PATH, HOME: dir, npm_config_cache: join(dir, "cache"),
        npm_config_userconfig: join(dir, "user.npmrc"), npm_config_globalconfig: join(dir, "global.npmrc"),
        npm_config_update_notifier: "false" } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("release manifests produce an offline locked install plan without package resolution", () => {
  const result = installPlan();
  assert.equal(result.status, 0, result.stderr);
});

test("offline locked install rejects a changed Next dependency without fetching packages", () => {
  const result = installPlan(true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOTCACHED[\s\S]*registry\.npmjs\.org\/next\b/);
});
