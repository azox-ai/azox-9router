import assert from "node:assert/strict";
import { test } from "node:test";
import config from "../../next.config.mjs";

function webpackConfig(cache, dev) {
  return config.webpack({ cache: { ...cache }, output: { hashFunction: "xxhash64" }, resolve: { fallback: {} }, watchOptions: {} }, { dev, isServer: false });
}

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
