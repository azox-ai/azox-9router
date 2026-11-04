import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// AZO-927 retired Contributor. AZO-936 carries combo import/export directly in
// upstream Sidebar/Header rather than the old customNavigation registry.
const source = (file) => readFileSync(new URL(`../../src/shared/components/${file}.js`, import.meta.url), "utf8");
const sidebar = source("Sidebar");
const header = source("Header");
const navSource = sidebar.match(/const navItems = (\[[\s\S]*?\n\]);/)[1];
const navItems = runInNewContext(`(${navSource})`);
const pageInfoSource = header.slice(header.indexOf("const getPageInfo ="), header.indexOf("export default function Header"));
const getPageInfo = runInNewContext(`${pageInfoSource}\ngetPageInfo;`);

describe("custom navigation integration", () => {
  it("keeps import/export between combos and usage in the rendered navigation", () => {
    const index = navItems.findIndex(({ href }) => href === "/dashboard/import-export");
    expect(index).toBeGreaterThan(0);
    expect(navItems.slice(index - 1, index + 2)).toEqual([
      { href: "/dashboard/combos", label: "Combo & Vision Adapter", icon: "layers" },
      { href: "/dashboard/import-export", label: "Import / Export", icon: "import_export" },
      { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
    ]);
    expect(sidebar).toContain("navItems.map(");
    expect(sidebar).toContain("href={item.href}");
  });

  it("resolves the carried import/export metadata", () => {
    expect(getPageInfo("/dashboard/import-export")).toEqual({
      title: "Import / Export",
      description: "Transfer combo definitions and routing settings",
      icon: "import_export",
      breadcrumbs: [],
    });
  });

  it("preserves upstream metadata without treating providers as a custom route", () => {
    expect(getPageInfo("/dashboard/providers")).toEqual({
      title: "Providers",
      description: "Manage your AI provider connections",
      icon: "dns",
      breadcrumbs: [],
    });
  });

  it("does not reintroduce retired Contributor navigation or metadata", () => {
    expect(navItems.some(({ href }) => href.startsWith("/dashboard/contributors"))).toBe(false);
    expect(getPageInfo("/dashboard/contributors/invite")).toEqual({ title: "", description: "", breadcrumbs: [] });
  });
});
