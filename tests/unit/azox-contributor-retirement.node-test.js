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
  assert.equal(guard, source("src/dashboardGuard.js", upstream));
});

test("direct-login OAuth and connection persistence remain upstream, not Contributor-overridden", () => {
  for (const path of ["src/app/api/oauth/[provider]/[action]/route.js", "src/lib/db/repos/connectionsRepo.js"]) {
    assert.equal(source(path), source(path, upstream), path);
  }
  assert.match(source("src/app/api/oauth/[provider]/[action]/route.js"), /export async function POST\(/);
});

test("manifest retires Contributor without claiming a production rollout", () => {
  const manifest = JSON.parse(source("docs/CUSTOMIZATIONS.yaml"));
  assert.equal(manifest.retired_customizations.contributor.classification, "retire");
  assert.equal(manifest.retired_customizations.contributor.deployed, false);
  assert.equal(manifest.provisional_contracts?.contributor, undefined);
  assert.deepEqual(Object.keys(manifest.supported_customizations).sort(), ["claude_assistant_prefill", "claude_cache"]);
});
