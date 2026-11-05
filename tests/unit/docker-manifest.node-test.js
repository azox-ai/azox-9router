import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = readFileSync(join(root, ".github/workflows/docker-publish.yml"), "utf8");
const step = workflow.match(/- name: Create and verify version manifest\n[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/)?.[1];
assert.ok(step);
const amd = "sha256:" + "1".repeat(64);
const arm = "sha256:" + "2".repeat(64);
const runtime = (digest, architecture) => ({ digest, platform: { os: "linux", architecture } });
const attestation = digest => ({ digest: "sha256:" + "3".repeat(64), platform: { os: "unknown", architecture: "unknown" },
  annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": digest } });

function validate(manifests) {
  const dir = mkdtempSync(join(tmpdir(), "9router-manifest-"));
  try {
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "digests"));
    mkdirSync(join(dir, "source/scripts"), { recursive: true });
    for (const [arch, digest] of [["amd64", amd], ["arm64", arm]]) writeFileSync(join(dir, "digests", `${arch}.txt`), digest + "\n");
    const docker = join(dir, "bin/docker");
    writeFileSync(docker, '#!/bin/sh\ncase "$*" in *"inspect --raw"*) printf %s "$INDEX_JSON";; esac\n');
    chmodSync(docker, 0o755);
    try { writeFileSync(join(dir, "source/scripts/validate-image-index.cjs"), readFileSync(join(root, "scripts/validate-image-index.cjs"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return spawnSync("bash", ["-c", step], { cwd: dir, encoding: "utf8", timeout: 5000,
      env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: dir, RUNNER_TEMP: dir,
        GHCR_IMAGE: "ghcr.io/azox-ai/azox-9router", VERSION: "0.5.112-azox.1",
        INDEX_JSON: JSON.stringify({ schemaVersion: 2, manifests }) } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("release manifest accepts both platforms plus linked BuildKit attestations", () => {
  const result = validate([runtime(amd, "amd64"), runtime(arm, "arm64"), attestation(amd), attestation(arm)]);
  assert.equal(result.status, 0, result.stderr);
});

test("release manifest rejects lost attestations", () => {
  assert.equal(validate([runtime(amd, "amd64"), runtime(arm, "arm64")]).status, 1);
});

test("release manifest rejects attestations linked to an absent runtime", () => {
  assert.equal(validate([runtime(amd, "amd64"), runtime(arm, "arm64"), attestation(amd), attestation(arm),
    attestation("sha256:" + "4".repeat(64))]).status, 1);
});

test("release manifest rejects duplicate runtime platforms", () => {
  assert.equal(validate([runtime(amd, "amd64"), runtime(arm, "arm64"), runtime(amd, "amd64"),
    attestation(amd), attestation(arm)]).status, 1);
});

test("release manifest rejects unexpected runtime platforms", () => {
  assert.equal(validate([runtime(amd, "amd64"), runtime(arm, "arm64"), runtime("sha256:" + "4".repeat(64), "s390x")]).status, 1);
});

test("release manifest rejects unlinked unknown-platform descriptors", () => {
  assert.equal(validate([runtime(amd, "amd64"), runtime(arm, "arm64"), { digest: "sha256:" + "4".repeat(64), platform: { os: "unknown", architecture: "unknown" } }]).status, 1);
});
