import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DISTRIBUTION_NOTICE_FILES, copyStandaloneAssets } from "../../scripts/copy-standalone-assets.mjs";

function createBuildFixture(distDir) {
  const projectRoot = mkdtempSync(join(tmpdir(), "9router-standalone-assets-"));
  const buildRoot = join(projectRoot, distDir);
  mkdirSync(join(buildRoot, "standalone"), { recursive: true });
  mkdirSync(join(buildRoot, "static", "chunks"), { recursive: true });
  mkdirSync(join(projectRoot, "public"), { recursive: true });
  mkdirSync(join(projectRoot, "node_modules", "sql.js", "dist"), { recursive: true });
  writeFileSync(join(buildRoot, "static", "chunks", "app.js"), "static asset");
  writeFileSync(join(projectRoot, "public", "favicon.svg"), "public asset");
  writeFileSync(join(projectRoot, "node_modules", "sql.js", "dist", "sql-wasm.wasm"), "wasm asset");
  for (const path of DISTRIBUTION_NOTICE_FILES) {
    mkdirSync(dirname(join(projectRoot, path)), { recursive: true });
    writeFileSync(join(projectRoot, path), `notice ${path}`);
  }
  return projectRoot;
}

describe("standalone build assets", () => {
  it("copies static and public assets into the default standalone layout", () => {
    const projectRoot = createBuildFixture(".next");

    copyStandaloneAssets({ projectRoot, distDir: ".next" });

    expect(readFileSync(join(projectRoot, ".next", "standalone", ".next", "static", "chunks", "app.js"), "utf8"))
      .toBe("static asset");
    expect(readFileSync(join(projectRoot, ".next", "standalone", "public", "favicon.svg"), "utf8"))
      .toBe("public asset");
    expect(readFileSync(join(projectRoot, ".next", "standalone", "node_modules", "sql.js", "dist", "sql-wasm.wasm"), "utf8"))
      .toBe("wasm asset");
  });

  it("uses a custom Next dist directory", () => {
    const projectRoot = createBuildFixture(".next-cli-build");

    copyStandaloneAssets({ projectRoot, distDir: ".next-cli-build" });

    expect(readFileSync(join(projectRoot, ".next-cli-build", "standalone", ".next-cli-build", "static", "chunks", "app.js"), "utf8"))
      .toBe("static asset");
  });

  // Without the wrapper beside server.js nothing can prove a request is local.
  it("copies the request-sanitizing server wrapper into the standalone output", () => {
    const projectRoot = createBuildFixture(".next");
    writeFileSync(join(projectRoot, "custom-server.js"), "wrapper");

    copyStandaloneAssets({ projectRoot, distDir: ".next" });

    expect(readFileSync(join(projectRoot, ".next", "standalone", "custom-server.js"), "utf8"))
      .toBe("wrapper");
  });

  it("does not modify workspace-traced CLI builds", () => {
    const projectRoot = createBuildFixture(".next-cli-build");
    const previousMode = process.env.NEXT_TRACING_ROOT_MODE;
    process.env.NEXT_TRACING_ROOT_MODE = "workspace";

    try {
      copyStandaloneAssets({ projectRoot, distDir: ".next-cli-build" });
    } finally {
      if (previousMode === undefined) delete process.env.NEXT_TRACING_ROOT_MODE;
      else process.env.NEXT_TRACING_ROOT_MODE = previousMode;
    }

    expect(() => readFileSync(join(projectRoot, ".next-cli-build", "standalone", ".next-cli-build", "static", "chunks", "app.js")))
      .toThrow();
  });

  it("fails the standalone postbuild when the required SQL.js runtime asset is missing", () => {
    const projectRoot = createBuildFixture(".next");
    unlinkSync(join(projectRoot, "node_modules", "sql.js", "dist", "sql-wasm.wasm"));

    expect(() => copyStandaloneAssets({ projectRoot, distDir: ".next" }))
      .toThrow("Required SQL.js runtime asset is missing");
  });

  it("ships license and third-party notice files beside the standalone server", () => {
    const projectRoot = createBuildFixture(".next");

    copyStandaloneAssets({ projectRoot, distDir: ".next" });

    expect(DISTRIBUTION_NOTICE_FILES).toEqual([
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "third_party/licenses/LGPL-3.0.txt",
      "third_party/licenses/GPL-3.0.txt",
    ]);
    for (const path of DISTRIBUTION_NOTICE_FILES) {
      expect(readFileSync(join(projectRoot, ".next", "standalone", path), "utf8")).toBe(`notice ${path}`);
    }
  });

  it("fails the standalone postbuild when a distribution notice is missing", () => {
    const projectRoot = createBuildFixture(".next");
    unlinkSync(join(projectRoot, "THIRD_PARTY_NOTICES.md"));

    expect(() => copyStandaloneAssets({ projectRoot, distDir: ".next" }))
      .toThrow(/Required distribution notice is missing/);
  });
});
