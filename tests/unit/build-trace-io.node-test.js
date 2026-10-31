import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { boundedReadFile, boundedNodeFileTrace } = require("../../scripts/build-trace-io.cjs");
const nft = require("next/dist/compiled/@vercel/nft");

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "build-trace-io-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// Removing the in-flight map must make the call count grow from 1 to 200.
test("tracing coalesces concurrent reads of the same real file", async () => {
  await fixture(async (dir) => {
    const path = join(dir, "package.json");
    await writeFile(path, '{"name":"fixture"}');
    let calls = 0;
    const read = boundedReadFile(async (p) => {
      calls++;
      await new Promise(setImmediate);
      return readFile(p, "utf8");
    }, 4);
    const values = await Promise.all(Array.from({ length: 200 }, () => read(path)));
    assert.equal(calls, 1);
    assert.ok(values.every((v) => v === '{"name":"fixture"}'));
  });
});

// Removing the semaphore must let 40 unique real reads run together, not 4.
test("tracing bounds distinct reads with descriptor headroom", async () => {
  await fixture(async (dir) => {
    const paths = Array.from({ length: 40 }, (_, i) => join(dir, `${i}.json`));
    await Promise.all(paths.map((p) => writeFile(p, "fixture")));
    let active = 0;
    let peak = 0;
    const read = boundedReadFile(async (p) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise(setImmediate);
        return await readFile(p);
      } finally { active--; }
    }, 4);
    const values = await Promise.all(paths.map((p) => read(p)));
    assert.ok(peak <= 4, `peak reads ${peak} exceeds 4`);
    assert.equal(values.length, 40);
    assert.ok(values.every((v) => Buffer.isBuffer(v) && v.toString() === "fixture"));
    assert.equal(active, 0);
  });
});

test("settled reads are not cached across file changes or errors", async () => {
  await fixture(async (dir) => {
    const path = join(dir, "changed.json");
    const read = boundedReadFile((p) => readFile(p, "utf8"), 1);
    await assert.rejects(read(path), { code: "ENOENT" });
    await writeFile(path, "first");
    assert.equal(await read(path), "first");
    await writeFile(path, "second");
    assert.equal(await read(path), "second");
    await rm(path);
    await assert.rejects(read(path), { code: "ENOENT" });
  });
});

test("bounded tracing preserves real NFT file and reason sets", async () => {
  await fixture(async (dir) => {
    await writeFile(join(dir, "entry.js"), 'require("./value.js");\n');
    await writeFile(join(dir, "value.js"), 'module.exports = "fixture";\n');
    await writeFile(join(dir, "package.json"), '{"name":"fixture","type":"commonjs"}');
    const files = [join(dir, "entry.js")];
    const options = { base: dir, processCwd: dir, readFile: (p) => readFile(p, "utf8") };
    const original = await nft.nodeFileTrace(files, options);
    const bounded = await boundedNodeFileTrace(nft.nodeFileTrace)(files, options);
    assert.deepEqual([...bounded.fileList].sort(), [...original.fileList].sort());
    assert.deepEqual([...bounded.esmFileList].sort(), [...original.esmFileList].sort());
    assert.deepEqual([...bounded.reasons.keys()].sort(), [...original.reasons.keys()].sort());
    assert.ok(bounded.fileList.has("value.js"));
    assert.equal(bounded.warnings.size, 0);
  });
});

test("build launcher loads the Next CLI without changing its version", () => {
  const result = spawnSync(process.execPath, ["scripts/build-next.cjs", "--version"], { encoding: "utf8" });
  const installed = require("next/package.json").version;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `Next.js v${installed}`);
  assert.equal(result.stderr, "");
});
