import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(resolve(root, "package.json"));
const layoutPath = resolve(root, "src/app/layout.js");

function fontOptions() {
  const layout = readFileSync(layoutPath, "utf8");
  assert.doesNotMatch(layout, /next\/font\/google|fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.match(layout, /import localFont from ["']next\/font\/local["']/);
  const call = layout.match(/const inter = localFont\(({[\s\S]*?})\);/);
  assert.ok(call, "root layout must load bundled Inter through next/font/local");
  return runInNewContext(`(${call[1]})`, Object.create(null), { timeout: 100 });
}

test("root Inter emits a local preloaded variable face with swap and existing CSS variable", async () => {
  const options = fontOptions();
  const loader = require("next/dist/compiled/@next/font/dist/local/loader").default;
  let emitted;
  const result = await loader({
    functionName: "",
    variableName: "inter",
    data: [options],
    resolve: async path => resolve(dirname(layoutPath), path),
    loaderContext: { fs: { readFile: readFileSyncCallback } },
    emitFontFile: (buffer, ext, preload) => {
      emitted = { buffer, ext, preload };
      return "/_next/static/media/inter.woff2";
    },
  });
  assert.equal(emitted.ext, "woff2");
  assert.equal(emitted.preload, true);
  assert.equal(emitted.buffer.toString("ascii", 0, 4), "wOF2");
  assert.equal(result.variable, "--font-inter");
  assert.match(result.css, /font-weight: 100 900;/);
  assert.match(result.css, /font-style: normal;/);
  assert.match(result.css, /font-display: swap;/);
  assert.match(result.css, /url\(\/_next\/static\/media\/inter\.woff2\)/);
  assert.doesNotMatch(result.css, /https?:/);
  assert.ok(result.adjustFontFallback, "derive local fallback metrics from real font");
});

function readFileSyncCallback(path, callback) {
  try { callback(null, readFileSync(path)); }
  catch (error) { callback(error); }
}

test("bundled Inter retains weight range and Latin, Vietnamese and Greek glyphs", () => {
  const options = fontOptions();
  const path = resolve(dirname(layoutPath), options.src);
  assert.ok(existsSync(path), "Inter asset must ship with source");
  const mod = require("next/dist/compiled/@next/font/dist/fontkit").default;
  const font = (mod.default || mod)(readFileSync(path));
  assert.match(font.familyName, /^Inter/);
  assert.equal(font.variationAxes.wght.min, 100);
  assert.equal(font.variationAxes.wght.max, 900);
  for (const character of "AaéĐệΩ") {
    assert.ok(font.hasGlyphForCodePoint(character.codePointAt(0)), `missing ${character}`);
  }
});

test("bundled Inter bytes match pinned provenance and redistributable license", () => {
  const path = resolve(root, "src/app/fonts/inter/PROVENANCE.json");
  assert.ok(existsSync(path), "font provenance must ship with source");
  const provenance = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(provenance.package, "inter-ui");
  assert.equal(provenance.version, "4.1.0");
  assert.equal(provenance.license, "OFL-1.1");
  for (const [name, hash] of Object.entries(provenance.files)) {
    assert.match(name, /^(InterVariable\.woff2|LICENSE\.txt)$/);
    const bytes = readFileSync(resolve(dirname(path), name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
  }
  assert.deepEqual(Object.keys(provenance.files).sort(), ["InterVariable.woff2", "LICENSE.txt"]);
  assert.match(readFileSync(resolve(dirname(path), "LICENSE.txt"), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
});
