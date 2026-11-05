import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = readFileSync(join(root, ".github/workflows/docker-publish.yml"), "utf8");
const step = workflow.match(/- name: Smoke-test platform image[^\n]*\n[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/)?.[1];
assert.ok(step, "exercise actual workflow smoke step");

function smoke(healthy, digestMismatch = false) {
  const dir = mkdtempSync(join(tmpdir(), "9router-smoke-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // Only external container/health boundaries are doubled. The real shell step runs.
    for (const [name, body] of Object.entries({
      docker: 'printf "docker %s\\n" "$*" >> "$CALLS"; exit 0',
      skopeo: 'printf "skopeo %s\\n" "$*" >> "$CALLS"; if [ "$1" = inspect ]; then printf %s "$RAW_INDEX"; fi',
      curl: 'exit "$HEALTH_EXIT"',
      sleep: 'exit 0',
    })) {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
    }
    mkdirSync(join(dir, "source/scripts"), { recursive: true });
    try {
      writeFileSync(join(dir, "source/scripts/smoke-platform.sh"), readFileSync(join(root, "scripts/smoke-platform.sh")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const raw = '{"schemaVersion":2,"manifests":[]}';
    const digest = "sha256:" + createHash("sha256").update(raw).digest("hex");
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, CALLS: join(dir, "calls"), RAW_INDEX: raw,
      HEALTH_EXIT: healthy ? "0" : "1", GHCR_IMAGE: "ghcr.io/azox-ai/azox-9router", IMAGE_DIGEST: digestMismatch ? "sha256:" + "0".repeat(64) : digest,
      PLATFORM: "linux/amd64", ARCH: "amd64", IMAGE_ARCHIVE: join(dir, "image.tar"),
      GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" };
    const script = step.replaceAll("${{ matrix.suffix }}", "amd64");
    const result = spawnSync("bash", ["-c", script], { cwd: dir, env, encoding: "utf8", timeout: 5000 });
    return { ...result, calls: readFileSync(env.CALLS, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("platform smoke loads the built OCI artifact locally without registry pull or push", () => {
  const result = smoke(true);
  assert.equal(result.status, 0, result.stderr);
  const run = result.calls.split("\n").find(line => line.startsWith("docker run "));
  assert.ok(run);
  assert.match(run, /--pull=never/);
  assert.match(run, /127\.0\.0\.1:20128:20128/);
  assert.doesNotMatch(run, /ghcr\.io/);
  assert.match(result.calls, /skopeo copy .*oci-archive:.*docker-daemon:/);
  assert.doesNotMatch(result.calls, /docker:\/\/|docker push/);
  assert.match(result.calls, /docker rm -f 9router-platform-smoke-/);
});

test("artifact digest mismatch stops before importing or running an image", () => {
  const result = smoke(true, true);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /OCI artifact digest mismatch/);
  assert.doesNotMatch(result.calls, /skopeo copy|docker /);
});

test("failed local platform health stops publication and cleans the smoke container", () => {
  const result = smoke(false);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.calls, /docker logs 9router-platform-smoke-/);
  assert.match(result.calls, /docker rm -f 9router-platform-smoke-/);
  assert.doesNotMatch(result.calls, /docker:\/\/|docker push/);
});
