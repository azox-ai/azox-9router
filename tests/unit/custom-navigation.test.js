import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// A12 retires Contributor and combo import/export, not ordinary combo routing.
// Assert the rendered Sidebar/Header integration and retired route surfaces.
const source = (file) => readFileSync(new URL(`../../src/shared/components/${file}.js`, import.meta.url), "utf8");
const sidebar = source("Sidebar");
const header = source("Header");
const navSource = sidebar.match(/const navItems = (\[[\s\S]*?\n\]);/)[1];
const navItems = runInNewContext(`(${navSource})`);
const pageInfoSource = header.slice(header.indexOf("const getPageInfo ="), header.indexOf("export default function Header"));
const getPageInfo = runInNewContext(`${pageInfoSource}\ngetPageInfo;`);

describe("custom navigation integration", () => {
  it("keeps combos next to usage without retired import/export navigation", () => {
    expect(navItems.some(({ href }) => href === "/dashboard/import-export")).toBe(false);
    const index = navItems.findIndex(({ href }) => href === "/dashboard/combos");
    expect(navItems.slice(index, index + 2)).toEqual([
      { href: "/dashboard/combos", label: "Combo & Vision Adapter", icon: "layers" },
      { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
    ]);
    expect(sidebar).toContain("navItems.map(");
    expect(sidebar).toContain("href={item.href}");
  });

  it("removes retired import/export page metadata and routes", () => {
    expect(getPageInfo("/dashboard/import-export")).toEqual({ title: "", description: "", breadcrumbs: [] });
    for (const path of ["app/(dashboard)/dashboard/import-export/page.js", "app/api/import-export/combos/route.js"]) {
      expect(existsSync(new URL(`../../src/${path}`, import.meta.url))).toBe(false);
    }
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
