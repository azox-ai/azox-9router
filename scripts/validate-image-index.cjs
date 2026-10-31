const fs = require("node:fs");

try {
  const index = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests)) throw new Error("Expected an image index");
  const runtimes = new Map();
  const attestations = [];
  for (const descriptor of index.manifests) {
    if (!/^sha256:[0-9a-f]{64}$/.test(descriptor.digest)) throw new Error("Invalid descriptor digest");
    const { os, architecture } = descriptor.platform || {};
    if (os === "linux" && ["amd64", "arm64"].includes(architecture)) {
      if (runtimes.has(architecture)) throw new Error(`Duplicate runtime platform: ${architecture}`);
      runtimes.set(architecture, descriptor.digest);
    } else if (os === "unknown" && architecture === "unknown"
      && descriptor.annotations?.["vnd.docker.reference.type"] === "attestation-manifest") {
      attestations.push(descriptor.annotations["vnd.docker.reference.digest"]);
    } else {
      throw new Error(`Unexpected platform: ${os}/${architecture}`);
    }
  }
  if (runtimes.size !== 2) throw new Error("Expected exactly linux/amd64 and linux/arm64");
  const digests = [...runtimes.values()];
  if (attestations.some(digest => !digests.includes(digest))
    || digests.some(digest => !attestations.includes(digest))) {
    throw new Error("Each runtime requires a linked attestation; no orphan attestations allowed");
  }
  console.log("Validated linux/amd64, linux/arm64 and linked attestation descriptors");
} catch (error) {
  console.error(`Image index validation failed: ${error.message}`);
  process.exitCode = 1;
}
