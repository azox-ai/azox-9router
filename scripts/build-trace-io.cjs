// Next's custom NFT readFile bypasses NFT's own cached/semaphored filesystem.
// Keep the override local to one trace: no value cache, mutation or error hiding.
function boundedReadFile(readFile, concurrency = 64) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Tracing read concurrency must be a positive integer");
  }
  const pending = new Map();
  const waiting = [];
  let active = 0;

  async function run(read) {
    if (active >= concurrency) await new Promise((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await read();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  return function (...args) {
    // NFT passes one string path. Do not conflate other signatures/options.
    const key = args.length === 1 && typeof args[0] === "string" ? args[0] : null;
    if (key !== null && pending.has(key)) return pending.get(key);
    const promise = run(() => Reflect.apply(readFile, this, args));
    if (key === null) return promise;
    const settled = promise.finally(() => pending.delete(key));
    pending.set(key, settled);
    return settled;
  };
}

function boundedNodeFileTrace(nodeFileTrace) {
  return function (files, options) {
    if (typeof options?.readFile !== "function") {
      return Reflect.apply(nodeFileTrace, this, [files, options]);
    }
    return Reflect.apply(nodeFileTrace, this, [files, {
      ...options,
      readFile: boundedReadFile(options.readFile),
    }]);
  };
}

function installBoundedTrace() {
  const id = require.resolve("next/dist/compiled/@vercel/nft");
  const nft = require(id);
  if (typeof nft.nodeFileTrace !== "function") {
    throw new TypeError("Unsupported Next NFT interface; review the build tracing adapter");
  }
  // Install before loading Next's CLI. Never edit installed dependency bytes or fs.
  const descriptors = Object.getOwnPropertyDescriptors(nft);
  descriptors.nodeFileTrace = { value: boundedNodeFileTrace(nft.nodeFileTrace), enumerable: true };
  require.cache[id].exports = Object.create(Object.getPrototypeOf(nft), descriptors);
}

module.exports = { boundedReadFile, boundedNodeFileTrace, installBoundedTrace };
