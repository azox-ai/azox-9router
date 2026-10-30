import assert from "node:assert/strict";
import { test } from "node:test";
import config from "../../next.config.mjs";

function webpackConfig(cache, dev, isServer = false, nextRuntime) {
  return config.webpack({ cache: cache && { ...cache }, output: { hashFunction: "xxhash64" }, resolve: { fallback: {} }, watchOptions: {} }, { dev, isServer, nextRuntime });
}

test("native production hashing preserves server, edge and disabled/memory cache behavior", () => {
  for (const nextRuntime of ["nodejs", "edge"]) {
    for (const cache of [false, { type: "memory" }, { type: "filesystem", compression: false }]) {
      const result = webpackConfig(cache, false, true, nextRuntime);
      assert.equal(result.output.hashFunction, "sha256");
      assert.equal(result.cache?.type ?? result.cache, cache?.type ?? cache);
      assert.equal(result.resolve.fallback.fs, undefined);
      if (cache?.type === "filesystem") assert.equal(result.cache.compression, "gzip");
    }
  }
});

test("production webpack cache compresses each file without disabling caching", () => {
  const result = webpackConfig({ type: "filesystem", compression: false }, false);
  assert.equal(result.cache.type, "filesystem");
  assert.equal(result.cache.compression, "gzip");
  assert.equal(result.resolve.fallback.fs, false);
});

test("production webpack hashing avoids WebAssembly address-space reservations", () => {
  const result = webpackConfig({ type: "filesystem", compression: false }, false);
  assert.equal(result.output.hashFunction, "sha256");
});

test("development webpack hashing retains the Next default", () => {
  const result = webpackConfig({ type: "filesystem", compression: "gzip" }, true);
  assert.equal(result.output.hashFunction, "xxhash64");
});

test("development webpack cache retains the Next default", () => {
  const result = webpackConfig({ type: "filesystem", compression: "gzip" }, true);
  assert.equal(result.cache.compression, "gzip");
});
