import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = readFileSync(join(root, ".github/workflows/docker-publish.yml"), "utf8");
const validator = workflow.match(/node <<'NODE'\n([\s\S]*?)\n\s+NODE(?:\n|$)/)?.[1];
assert.ok(validator, "publishing workflow must expose its actual Node validator");

function validate(tag, { rootVersion, cliVersion, event = "push" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "9router-release-"));
  try {
    mkdirSync(join(dir, "cli"));
    for (const [path, version] of [["package.json", rootVersion], ["cli/package.json", cliVersion]]) {
      const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
      if (version !== undefined) manifest.version = version;
      writeFileSync(join(dir, path), JSON.stringify(manifest));
    }
    const env = { PATH: process.env.PATH, HOME: dir, LANG: "C.UTF-8" };
    execFileSync("git", ["init", "--quiet", dir], { env });
    // Detached ref is sufficient for rev-parse; no commit or identity is needed.
    writeFileSync(join(dir, ".git/HEAD"), "1111111111111111111111111111111111111111\n");
    const output = join(dir, "outputs");
    const result = spawnSync(process.execPath, ["-e", validator], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, RELEASE_TAG: tag, REPOSITORY: "azox-ai/azox-9router", EVENT_NAME: event,
        PROMOTE_LATEST_INPUT: "false", GITHUB_OUTPUT: output },
    });
    return { ...result, outputs: result.status === 0 ? readFileSync(output, "utf8") : "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("AZOX release tag validates real package versions without promoting latest", () => {
  const result = validate("v0.5.112-azox.1");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.outputs, /^version=0\.5\.112-azox\.1$/m);
  assert.match(result.outputs, /^commit=1111111111111111111111111111111111111111$/m);
  assert.match(result.outputs, /^ghcr_image=ghcr\.io\/azox-ai\/azox-9router$/m);
  assert.match(result.outputs, /^publish_dockerhub=false$/m);
  assert.match(result.outputs, /^promote_latest=false$/m);
});

test("publishing rejects a root version mismatch", () => {
  const result = validate("v0.5.112-azox.1", { rootVersion: "0.5.112" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /package\.json version .* does not match tag/);
});

test("publishing rejects a CLI version mismatch", () => {
  const result = validate("v0.5.112-azox.1", { rootVersion: "0.5.112-azox.1", cliVersion: "0.5.112" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cli\/package\.json version .* does not match tag/);
});

for (const tag of ["0.5.112", "v00.5.112", "v0.5.112-azox.01", "v0.5.112+azox.1", "v0.5.112-", "v0.5.112-" + "x".repeat(128)]) {
  test(`publishing rejects unsafe or invalid tag ${tag}`, () => {
    assert.equal(validate(tag).status, 1);
  });
}

for (const path of ["cli/cli.js", "src/app/api/version/route.js"]) {
  test(`${path} detects upstream patch updates from an AZOX package version`, () => {
    const source = readFileSync(join(root, path), "utf8");
    const fn = source.match(/^function compareVersions\(a, b\) \{[\s\S]*?^\}/m)?.[0];
    assert.ok(fn, "exercise the real version comparator without CLI startup or network lookup");
    const compare = runInNewContext(`(${fn})`);
    assert.equal(compare("0.5.113", "0.5.112-azox.1"), 1);
    assert.equal(compare("0.5.111", "0.5.112-azox.1"), -1);
    assert.equal(compare("0.5.112", "0.5.112-azox.1"), 0);
    assert.equal(compare("0.6.0", "0.5.112-azox.1"), 1);
    assert.equal(compare("0.5.112-azox.1", "0.5.113"), -1);
  });
}

test("stable upstream tag retains existing latest policy", () => {
  const result = validate("v0.5.112", { rootVersion: "0.5.112", cliVersion: "0.5.112" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.outputs, /^promote_latest=true$/m);
});
