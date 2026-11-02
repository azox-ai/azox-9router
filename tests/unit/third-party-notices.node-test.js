import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DISTRIBUTION_NOTICE_FILES, copyStandaloneAssets } from "../../scripts/copy-standalone-assets.mjs";
import {
  APK_LINE,
  CLOSURE_FILE,
  DOCKERFILE_COPIES,
  NOTICE_FILE,
  collectNoticeInputs,
  generateNotices,
} from "../../scripts/generate-third-party-notices.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = path => readFileSync(join(root, path), "utf8");

test("committed third-party notice is exactly the output generated from closure, lock and license sources", () => {
  assert.equal(read(NOTICE_FILE), generateNotices(root));
});

test("notice lists every traced closure package and Dockerfile copy with lock version and license", () => {
  const closure = JSON.parse(read(CLOSURE_FILE));
  const lock = JSON.parse(read("package-lock.json")).packages;
  const notice = read(NOTICE_FILE);
  const { packages } = collectNoticeInputs(root);
  const expected = new Set([...closure.closure.packages.map(item => item.path), ...DOCKERFILE_COPIES.map(item => item.path)]);

  assert.equal(closure.closure.package_count, 59);
  assert.deepEqual(packages.map(item => item.path).sort(), [...expected].sort());
  for (const path of expected) {
    const { version, license } = lock[path];
    const row = `| \`${path.replace(/^node_modules\//, "")}\` | ${version} | \`${license}\` |`;
    assert.ok(notice.includes(row), `missing inventory row for ${path}`);
  }
});

test("notice covers LGPL replacement, CC-BY attribution, node-forge election and the apk SBOM limit", () => {
  const notice = read(NOTICE_FILE);
  const lgpl = read("third_party/licenses/LGPL-3.0.txt");
  assert.match(lgpl, /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.match(read("third_party/licenses/GPL-3.0.txt"), /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.ok(notice.includes(lgpl.trimEnd()), "full LGPLv3 text must be reproduced");
  assert.match(notice, /How to replace the LGPL library/);
  assert.match(notice, /RPATH that points to `node_modules\/@img\/sharp-libvips-<platform>\/lib`/);
  assert.match(notice, /Creative Commons Attribution 4\.0 International/);
  assert.match(notice, /Attribution 4\.0 International/);
  assert.match(notice, /9router elects the BSD-3-Clause license/);
  assert.ok(notice.includes(APK_LINE));
  assert.match(notice, /can only be fixed by an SBOM of the built image/);
  assert.match(notice, /This notice makes no license claim for them/);
  assert.doesNotMatch(notice, /ffmpeg[^\n]*(LGPL|GPL)-[0-9]/, "ffmpeg license must not be asserted without an image SBOM");
});

test("root package.json declares the repository MIT license", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.license, "MIT");
  assert.match(read("LICENSE"), /^MIT License\n\nCopyright \(c\) 2024-2026 decolua and contributors\n/);
});

test("notice files are on the postbuild and Docker copy path without new runtime inputs", () => {
  const dockerfile = read("Dockerfile");
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.scripts.postbuild, "node scripts/copy-standalone-assets.mjs");
  assert.match(dockerfile, /RUN --network=none npm run build/);
  assert.match(dockerfile, /COPY --from=builder \/app\/\.next\/standalone \.\//);
  assert.doesNotMatch(read(".dockerignore"), /^(LICENSE|THIRD_PARTY_NOTICES\.md|third_party)\b/m);
  assert.deepEqual(DISTRIBUTION_NOTICE_FILES, [
    "LICENSE",
    NOTICE_FILE,
    "third_party/licenses/LGPL-3.0.txt",
    "third_party/licenses/GPL-3.0.txt",
  ]);

  const project = mkdtempSync(join(tmpdir(), "9router-notices-"));
  try {
    mkdirSync(join(project, ".next", "standalone"), { recursive: true });
    mkdirSync(join(project, "node_modules", "sql.js", "dist"), { recursive: true });
    writeFileSync(join(project, "node_modules", "sql.js", "dist", "sql-wasm.wasm"), "wasm");
    for (const path of DISTRIBUTION_NOTICE_FILES) {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), read(path));
    }
    copyStandaloneAssets({ projectRoot: project, distDir: ".next" });
    for (const path of DISTRIBUTION_NOTICE_FILES) {
      assert.equal(readFileSync(join(project, ".next", "standalone", path), "utf8"), read(path));
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
