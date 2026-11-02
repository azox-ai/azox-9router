// Generates THIRD_PARTY_NOTICES.md from committed source data only:
//   - third_party/standalone-closure-glibc-x64.json (traced Next standalone closure)
//   - package-lock.json (version + SPDX license for every listed install path)
//   - third_party/license-sources.json + third_party/license-sources/** (original
//     license/notice files copied from the hash-verified offline kit)
//   - Dockerfile (packages copied outside the trace and the apk runtime packages)
// `--check` regenerates in memory and fails when the committed notice differs.
// No network, install, build or target launch is involved.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NOTICE_FILE = "THIRD_PARTY_NOTICES.md";
export const CLOSURE_FILE = "third_party/standalone-closure-glibc-x64.json";
export const SOURCES_FILE = "third_party/license-sources.json";
export const LICENSE_TEXTS = [
  { path: "third_party/licenses/LGPL-3.0.txt", title: "GNU Lesser General Public License v3" },
  { path: "third_party/licenses/GPL-3.0.txt", title: "GNU General Public License v3 (incorporated by LGPLv3)" },
];
// Copied by explicit Dockerfile COPY lines (node-forge, next, sql.js,
// node-machine-id) or the lazy-runtime stage (wreq-js, @wreq-js, playwright-core).
export const DOCKERFILE_COPIES = [
  { path: "node_modules/node-forge", dockerfile: "COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge" },
  { path: "node_modules/next", dockerfile: "COPY --from=builder /app/node_modules/next ./node_modules/next" },
  { path: "node_modules/sql.js", dockerfile: "COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js" },
  { path: "node_modules/node-machine-id", dockerfile: "COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id" },
  { path: "node_modules/wreq-js", dockerfile: "cp -a node_modules/wreq-js node_modules/playwright-core node_modules/@wreq-js" },
  { path: "node_modules/playwright-core", dockerfile: "cp -a node_modules/wreq-js node_modules/playwright-core node_modules/@wreq-js" },
  { path: "node_modules/@wreq-js/binding-linux-x64-gnu", dockerfile: "cp -a node_modules/wreq-js node_modules/playwright-core node_modules/@wreq-js" },
];
export const MUSL_COUNTERPARTS = [
  "node_modules/@img/sharp-libvips-linuxmusl-x64",
  "node_modules/@img/sharp-libvips-linuxmusl-arm64",
  "node_modules/@img/sharp-linuxmusl-x64",
  "node_modules/@img/sharp-linuxmusl-arm64",
  "node_modules/@wreq-js/binding-linux-x64-musl",
  "node_modules/@wreq-js/binding-linux-arm64-musl",
];
export const APK_LINE = "apk add --no-cache su-exec ffmpeg";

const sha256 = text => createHash("sha256").update(text).digest("hex");

function fail(message) {
  throw new Error(`[third-party-notices] ${message}`);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

export function collectNoticeInputs(root) {
  const read = path => readFileSync(resolve(root, path), "utf8");
  const closure = JSON.parse(read(CLOSURE_FILE));
  const sources = JSON.parse(read(SOURCES_FILE));
  const lock = JSON.parse(read("package-lock.json")).packages;
  const dockerfile = read("Dockerfile");

  expect(closure.closure?.present === true, "closure snapshot is not marked present");
  expect(closure.closure.packages.length === closure.closure.package_count, "closure package_count mismatch");
  expect(sources.closure_head === closure.head, "license-sources manifest was built for another closure head");
  expect(dockerfile.includes("COPY --from=builder /app/.next/standalone ./"), "Dockerfile no longer ships .next/standalone");
  expect(dockerfile.includes(APK_LINE), `Dockerfile runtime apk line changed; expected "${APK_LINE}"`);

  const packages = new Map();
  const add = (path, origin) => {
    const entry = lock[path];
    expect(entry?.version && entry?.license, `package-lock has no version/license for ${path}`);
    if (packages.has(path)) {
      packages.get(path).origins.push(origin);
      return;
    }
    packages.set(path, { path, version: entry.version, license: entry.license, origins: [origin] });
  };
  for (const item of closure.closure.packages) {
    const entry = lock[item.path];
    expect(entry?.version === item.version && entry?.license === item.license,
      `closure ${item.path} ${item.version}/${item.license} differs from package-lock`);
    add(item.path, "traced standalone (glibc x64)");
  }
  for (const copy of DOCKERFILE_COPIES) {
    expect(dockerfile.includes(copy.dockerfile), `Dockerfile no longer contains: ${copy.dockerfile}`);
    add(copy.path, "Dockerfile copy");
  }

  const manifestPaths = sources.packages.map(item => item.path).sort();
  expect(JSON.stringify(manifestPaths) === JSON.stringify([...packages.keys()].sort()),
    "license-sources manifest does not list exactly the shipped package paths");

  const texts = new Map();
  for (const source of sources.packages) {
    const item = packages.get(source.path);
    expect(source.version === item.version && source.license === item.license,
      `license-sources metadata for ${source.path} differs from package-lock`);
    expect(/^[a-f0-9]{64}$/.test(source.metadata_sha256 || ""), `missing package.json hash for ${source.path}`);
    item.name = source.name;
    item.author = source.author || "not stated";
    item.repository = source.repository || "not stated";
    item.files = source.files.map(file => file.path);
    for (const file of source.files) {
      expect(file.path.startsWith("third_party/license-sources/") && !file.path.includes(".."), `unsafe source path ${file.path}`);
      const text = read(file.path);
      expect(sha256(text) === file.sha256, `license source changed after capture: ${file.path}`);
      texts.set(file.path, text);
    }
  }
  for (const license of LICENSE_TEXTS) texts.set(license.path, read(license.path));

  const musl = MUSL_COUNTERPARTS.map(path => {
    expect(lock[path]?.version && lock[path]?.license, `package-lock has no musl counterpart ${path}`);
    return { path, version: lock[path].version, license: lock[path].license };
  });

  return { closure, packages: [...packages.values()].sort((a, b) => a.path.localeCompare(b.path, "en")), texts, musl };
}

function byName(packages, name) {
  const item = packages.find(entry => entry.path === `node_modules/${name}`);
  expect(item, `required package ${name} is not shipped`);
  return item;
}

function fenced(text) {
  const longest = Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text.trimEnd()}\n${fence}`;
}

export function renderNotices({ closure, packages, texts, musl }) {
  const libvips = byName(packages, "@img/sharp-libvips-linux-x64");
  const wasm = byName(packages, "@img/sharp-wasm32");
  const sharp = byName(packages, "sharp");
  const caniuse = byName(packages, "caniuse-lite");
  const forge = byName(packages, "node-forge");
  expect(libvips.license === "LGPL-3.0-or-later", "libvips license changed; review LGPL section");
  expect(wasm.license === "Apache-2.0 AND LGPL-3.0-or-later AND MIT", "sharp-wasm32 license changed; review LGPL section");
  expect(caniuse.license === "CC-BY-4.0", "caniuse-lite license changed; review attribution section");
  expect(forge.license === "(BSD-3-Clause OR GPL-2.0)", "node-forge license changed; review license election");
  expect(texts.has("third_party/license-sources/caniuse-lite/LICENSE"), "caniuse-lite CC-BY-4.0 text missing");
  expect(texts.has("third_party/license-sources/node-forge/LICENSE"), "node-forge LICENSE missing");
  expect(texts.has("third_party/license-sources/@img/sharp-libvips-linux-x64/README.md"), "libvips licensing README missing");

  const counts = new Map();
  for (const item of packages) counts.set(item.license, (counts.get(item.license) || 0) + 1);
  const countRows = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b, "en"))
    .map(([license, count]) => `| \`${license}\` | ${count} |`).join("\n");
  const inventoryRows = packages.map(item => {
    const files = item.files.length
      ? item.files.map(path => `\`${path}\``).join("<br>")
      : `no license file in package; package.json author: ${item.author}; repository: ${item.repository}`;
    return `| \`${item.path.replace(/^node_modules\//, "")}\` | ${item.version} | \`${item.license}\` | ${item.origins.join("; ")} | ${files} |`;
  }).join("\n");
  const muslRows = musl.map(item => `| \`${item.path.replace(/^node_modules\//, "")}\` | ${item.version} | \`${item.license}\` |`).join("\n");
  // Byte-identical texts are printed once, headed by every file that has them.
  const groups = new Map();
  for (const path of [...texts.keys()].sort((a, b) => a.localeCompare(b, "en"))) {
    const text = texts.get(path);
    const key = sha256(text);
    if (!groups.has(key)) groups.set(key, { text, paths: [] });
    groups.get(key).paths.push(path);
  }
  const textSections = [...groups.values()]
    .map(group => `### ${group.paths.map(path => `\`${path}\``).join(", ")}\n\n${fenced(group.text)}`).join("\n\n");

  return `# Third-party notices

Generated by \`node scripts/generate-third-party-notices.mjs\`; verify with \`--check\`. Do not edit by hand.

9router itself is licensed under the MIT License (\`LICENSE\`, Copyright (c) 2024-2026 decolua and contributors). This file covers third-party components shipped in the Next.js standalone output and the Docker runtime image built from this repository.

## Sources and limits

- Package list: traced Next standalone closure \`${CLOSURE_FILE}\` (source head \`${closure.head}\`, ${closure.closure.package_count} packages, ${closure.closure.file_count} files, Linux x64 **glibc**), plus the packages the \`Dockerfile\` copies outside the trace.
- Version and SPDX license of each install path: \`package-lock.json\`. License and notice texts: original files copied from the hash-verified offline kit, each pinned by SHA-256 in \`${SOURCES_FILE}\`.
- The Docker runner is Alpine Linux (**musl**) on amd64/arm64. Platform-specific native packages in the image differ from the glibc closure above, and no image SBOM exists yet. This notice is therefore not a complete inventory of the image.
- Not inventoried here: third-party code that webpack bundled into \`.next/server\` or \`.next/static\` chunks, Next's own precompiled dependencies (\`next/dist/compiled\`, covered only through the \`next\` entry), and third-party code ported into this repository's own sources. Those remain open review items in \`docs/OFFLINE-BUILD.md\`.

## Alpine image packages (license not determined here)

The runtime stage runs \`${APK_LINE}\`. \`su-exec\`, \`ffmpeg\` and their transitive Alpine packages, plus the packages of the Node.js Alpine base image, are dependencies of the Alpine image. Their exact versions and licenses can only be fixed by an SBOM of the built image (OCI gate still closed). This notice makes no license claim for them.

Possible musl counterparts recorded in \`package-lock.json\` (whether and which of these land in the image must be confirmed by the image SBOM):

| Package | Version | License (package-lock) |
|---|---|---|
${muslRows}

## Specific obligations and elections

### libvips and sharp: LGPL-3.0-or-later

- \`@img/sharp-libvips-linux-x64\` ${libvips.version} is \`${libvips.license}\`. It ships libvips and other native libraries as the shared library \`libvips-cpp.so\`. Its README, reproduced below, lists each bundled library and its license (several are LGPLv3).
- \`@img/sharp-wasm32\` ${wasm.version} is \`${wasm.license}\`. \`sharp\` ${sharp.version} itself is \`${sharp.license}\`.
- LGPLv3 text: \`third_party/licenses/LGPL-3.0.txt\`. It incorporates GPLv3, included as \`third_party/licenses/GPL-3.0.txt\`. Both are reproduced at the end of this file and ship beside it in the standalone output.
- Corresponding source for the LGPL libraries: the package repository \`${libvips.repository}\` (package version ${libvips.version}) and the upstream projects its README names. 9router does not modify these libraries; \`package-lock.json\` pins the published package by integrity hash.

How to replace the LGPL library (LGPLv3 section 4(d)(1)):

1. The prebuilt sharp addon \`@img/sharp-<platform>/lib/sharp-<platform>-${sharp.version}.node\` does not contain libvips. It loads \`libvips-cpp.so.<libvips version>\` at runtime via an RPATH that points to \`node_modules/@img/sharp-libvips-<platform>/lib\`. This was checked on the linux-x64 glibc addon (\`libvips-cpp.so.8.18.7\`); the musl addons in the image must be checked against the image SBOM.
2. To run with a modified libvips, build an interface-compatible \`libvips-cpp.so\` with the same file name and put it in that \`lib\` directory. In a container image, this means building a new image with that file replaced.
3. Alternatively, build sharp from source against a globally installed libvips (sharp requires libvips >= 8.18.7; set \`SHARP_FORCE_GLOBAL_LIBVIPS\` at build time). See \`https://sharp.pixelplumbing.com/install#building-from-source\`.
4. The WebAssembly fallback \`@img/sharp-wasm32\` ships its libraries inside the single module \`sharp-wasm32-${wasm.version}.node.wasm\`, so they cannot be swapped in place. To change them, rebuild that package from \`${wasm.repository}\` (directory \`npm/wasm32\`). Its README, reproduced below, lists the bundled libraries. sharp only loads this fallback when no native addon loads.

### caniuse-lite: CC-BY-4.0 attribution

\`caniuse-lite\` ${caniuse.version} by ${caniuse.author} (repository \`https://github.com/${caniuse.repository}\`) is "A smaller version of caniuse-db" (its package description). It is licensed under Creative Commons Attribution 4.0 International (CC BY 4.0, \`https://creativecommons.org/licenses/by/4.0/\`). The full license text is reproduced below. 9router does not modify the package; the standalone build includes the traced files as published.

### node-forge: BSD-3-Clause elected

\`node-forge\` ${forge.version} is offered under \`${forge.license}\`. **For this distribution, 9router elects the BSD-3-Clause license.** The original LICENSE file, including the BSD notice of Digital Bazaar, Inc., is reproduced below.

## License summary

| License (package metadata) | Packages |
|---|---|
${countRows}

## Shipped package inventory

| Package (install path under \`node_modules/\`) | Version | License | Shipped via | License and notice files reproduced below |
|---|---|---|---|---|
${inventoryRows}

Some packages ship no license file; for them the inventory shows the author and repository from their \`package.json\`. They are distributed under the license named by their SPDX id, whose standard text appears below in another package's file (MIT or Apache-2.0). No copyright line is invented for them.

## License and notice texts

Each text below is reproduced byte-for-byte from the listed file(s); files with identical content share one copy.

${textSections}
`;
}

export function generateNotices(root) {
  return renderNotices(collectNoticeInputs(root));
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const generated = generateNotices(root);
  const output = resolve(root, NOTICE_FILE);
  if (process.argv.includes("--check")) {
    const current = readFileSync(output, "utf8");
    if (current !== generated) fail(`${NOTICE_FILE} is stale; run node scripts/generate-third-party-notices.mjs`);
    console.log(`[third-party-notices] ${NOTICE_FILE} matches source data (sha256 ${sha256(current)})`);
    return;
  }
  writeFileSync(output, generated);
  console.log(`[third-party-notices] Wrote ${NOTICE_FILE} (sha256 ${sha256(generated)})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
