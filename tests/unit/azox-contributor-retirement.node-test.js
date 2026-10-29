import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ref = process.env.AZOX_RETIREMENT_REF;
const upstream = "3a978a631ad65529c06e48ce495092d5bba29f46";

function source(path, revision = ref) {
  if (revision) return execFileSync("git", ["show", `${revision}:${path}`], { cwd: root, encoding: "utf8" });
  return readFileSync(resolve(root, path), "utf8");
}

function routes() {
  if (ref) {
    return execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "src/app", "src/lib/contributor", "src/shared/constants/customNavigation.js"], { cwd: root, encoding: "utf8" }).split("\n");
  }
  return execFileSync("git", ["ls-files", "src/app", "src/lib/contributor", "src/shared/constants/customNavigation.js"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(path => existsSync(resolve(root, path)));
}

test("candidate has no AZOX Contributor dashboard, API route or service", () => {
  const paths = routes();
  assert.equal(paths.some(path => /^src\/app\/(?:api\/)?(?:contribute|contributor)(?:-admin)?(?:\/|$)/.test(path)), false);
  assert.equal(paths.some(path => path === "src/app/(dashboard)/dashboard/contributors/page.js"), false);
  assert.equal(paths.some(path => path.startsWith("src/lib/contributor/")), false);
  if (paths.includes("src/shared/constants/customNavigation.js")) {
    assert.doesNotMatch(source("src/shared/constants/customNavigation.js"), /\/dashboard\/contributors/);
  }
});

test("Contributor is not allowed through the public dashboard guard", () => {
  const guard = source("src/dashboardGuard.js");
  assert.equal(guard.includes('"/api/contribute"'), false);
  assert.equal(guard.includes('"/api/contributor-admin"'), false);
  assert.doesNotMatch(guard, /contribut/i);
  // The only allowed guard delta is the Portal machine route (portal_credential_sync).
  // Every upstream line stays in place, so no upstream gate is removed or loosened.
  const upstreamLines = source("src/dashboardGuard.js", upstream).split("\n");
  const candidateLines = new Set(guard.split("\n"));
  assert.deepEqual(upstreamLines.filter(line => !candidateLines.has(line)), []);
});

test("direct-login OAuth remains upstream, not Contributor-overridden", () => {
  const oauth = "src/app/api/oauth/[provider]/[action]/route.js";
  assert.equal(source(oauth), source(oauth, upstream));
  assert.match(source(oauth), /export async function POST\(request, \{ params \}\) \{/);
});

test("connection persistence carries no Contributor commit hook", () => {
  // connectionsRepo.js legitimately changes for portal_credential_sync. Assert
  // the Contributor overlay (reservation commit hook) is absent instead of
  // requiring the whole file to equal upstream.
  const repo = source("src/lib/db/repos/connectionsRepo.js");
  assert.doesNotMatch(repo, /contribut|shouldCommit|commitProviderConnection|reservation/i);
  assert.match(repo, /^export async function createProviderConnection\(data\) \{$/m);
});

test("manifest retires Contributor without claiming a production rollout", () => {
  const manifest = JSON.parse(source("docs/CUSTOMIZATIONS.yaml"));
  assert.equal(manifest.retired_customizations.contributor.classification, "retire");
  assert.equal(manifest.retired_customizations.contributor.deployed, false);
  assert.equal(manifest.provisional_contracts?.contributor, undefined);
  assert.deepEqual(Object.keys(manifest.supported_customizations).sort(), [
    "claude_assistant_prefill", "claude_cache", "combo_import_export", "portal_credential_sync",
  ]);
  assert.doesNotMatch(JSON.stringify(manifest.supported_customizations), /contribut/i);
});
