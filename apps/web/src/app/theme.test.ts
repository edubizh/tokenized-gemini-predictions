import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLORS, contrast, ground, mix, MIXES, NAV_ALPHA, PAIRINGS, THEME, UNUSED, type ColorName } from "./theme";

const read = (relative: string) => readFileSync(path.resolve(import.meta.dirname, relative), "utf8");
const stylesheet = read("./globals.css");
const design = read("../../../../docs/DESIGN.md");

/** The stylesheets of the design system: the global one, and those of the components and the reference page. */
const sheets = ["../components", "../features/gallery"]
  .flatMap((folder) => (readdirSync(path.resolve(import.meta.dirname, folder), { recursive: true }) as string[]).map((file) => `${folder}/${file}`))
  .filter((file) => file.endsWith(".css"))
  .map((file) => [file, read(file)] as const)
  .concat([["./globals.css", stylesheet]]);

/** The declarations of the first rule with this selector. */
const rule = (css: string, selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

/** Every `--name: #RRGGBB;` the stylesheet declares. */
const declared = Object.fromEntries([...stylesheet.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((match) => [match[1], match[2]!.toUpperCase()]));
const declaredNavAlpha = Number(/--nav-alpha:\s*(\d+)%;/.exec(stylesheet)?.[1]) / 100;

describe("the palette in globals.css", () => {
  it("declares the colours of the design system and no others", () => {
    expect(declared).toEqual(COLORS);
  });

  it("has four theme colours, one exception, and nothing else that is not a mix of them", () => {
    const free = (Object.keys(COLORS) as ColorName[]).filter((name) => !MIXES[name]);
    expect(free).toEqual([...THEME, "clay"]);
  });

  it.each(Object.entries(MIXES))("%s is the mix it is said to be", (name, [from, percent, into]) => {
    expect(declared[name]).toBe(mix(declared[from]!, declared[into]!, percent));
  });

  it("fills the navbar at the opacity the contrast figures assume", () => {
    expect(declaredNavAlpha).toBe(NAV_ALPHA);
  });

  it("writes every see-through colour as forest with an alpha, in a form every browser reads", () => {
    const forest = [1, 3, 5].map((at) => parseInt(declared.forest!.slice(at, at + 2), 16)).join(" ");
    const found = sheets.flatMap(([file, css]) => [...css.matchAll(/rgba?\(([^)]*)\)/g)].map((match) => [file, match[1]!] as const));
    expect(found.length).toBeGreaterThan(0);
    for (const [file, inside] of found) expect(inside, file).toMatch(new RegExp(`^${forest} / 0\\.\\d+$`));
  });

  it("draws the icon in theme colours only", () => {
    const used = [...read("./icon.svg").matchAll(/#[0-9a-fA-F]{6}/g)].map((match) => match[0].toUpperCase());
    expect(used.length).toBeGreaterThan(0);
    for (const hex of used) expect(THEME.map((name) => COLORS[name])).toContain(hex);
  });

  it("uses color-mix only where the browser has been asked whether it knows it", () => {
    const users = sheets.filter(([, css]) => css.includes("color-mix(")).map(([file]) => file);
    expect(users).toEqual(["../components/shell/Navbar.module.css"]);
    expect(read(users[0]!)).toMatch(/@supports [^{]*\(background: color-mix\(in srgb, red 50%, blue\)\)/);
  });
});

describe("contrast, WCAG 2.1 AA", () => {
  it.each(PAIRINGS.map((pair) => [pair.text, pair.on, pair.min] as const))("%s on %s is at least %s:1", (text, on, min) => {
    const colors = declared as Record<ColorName, string>;
    expect(contrast(colors[text], ground(on, colors, declaredNavAlpha))).toBeGreaterThanOrEqual(min);
  });

  it("gives a control inside a tinted notice a forest boundary, since edge does not hold on a tint", () => {
    const notice = read("../components/ui/Notice.module.css");
    expect(notice).toMatch(/\.positive,\s*\.negative\s*\{[^}]*--edge:\s*var\(--forest\)/);
    for (const tint of ["jade-tint", "clay-tint"] as const) expect(contrast(COLORS.edge, COLORS[tint])).toBeLessThan(3.1);
  });

  it("keeps the navbar and the wallet control to forest and jade, which hold over anything that scrolls beneath", () => {
    const navbar = read("../components/shell/Navbar.module.css");
    const trigger = rule(read("../components/shell/AccountMenu.module.css"), ".trigger");
    expect(trigger).toContain("var(--forest)");
    expect(navbar + trigger).not.toMatch(/var\(--(edge|forest-soft|line)\)/);
  });
});

describe("docs/DESIGN.md", () => {
  it("lists the same colours in its front matter", () => {
    const block = /^colors:\n((?: {2}.+\n)+)/m.exec(design)?.[1] ?? "";
    const listed = Object.fromEntries([...block.matchAll(/^ {2}([a-z-]+): "(#[0-9A-F]{6})"$/gm)].map((match) => [match[1], match[2]]));
    expect(listed).toEqual(COLORS);
  });

  it("gives each token its value and its mix", () => {
    const rows = [...design.matchAll(/^\| `([a-z-]+)` \| `(#[0-9A-F]{6})` \| ([^|]+) \|/gm)].map((match) => [match[1], match[2], match[3]!.trim()]);
    const expected = (Object.keys(COLORS) as ColorName[]).map((name) => {
      const recipe = MIXES[name];
      return [name, COLORS[name], recipe ? `${recipe[0]} ${recipe[1]}% in ${recipe[2]}` : name === "clay" ? "exception" : "theme"];
    });
    expect(rows).toEqual(expected);
  });

  it("lists every pairing with the ratio it really has", () => {
    const rows = [...design.matchAll(/^\| `([a-z-]+)` \| `([a-z-]+)` \| ([\d.]+) \| ([\d.]+) \|/gm)].map((match) => match.slice(1, 5));
    const expected = PAIRINGS.map((pair) => [pair.text, pair.on, contrast(COLORS[pair.text], ground(pair.on)).toFixed(2), String(pair.min)]);
    expect(rows).toEqual(expected);
  });

  it("lists the pairings that are avoided with the ratio they really have", () => {
    const rows = [...design.matchAll(/^\| `([a-z-]+)` \| `([a-z-]+)` \| ([\d.]+) \| (?![\d.]+ \|)/gm)].map((match) => match.slice(1, 4));
    const expected = UNUSED.map((pair) => [pair.text, pair.on, contrast(COLORS[pair.text], COLORS[pair.on]).toFixed(2)]);
    expect(rows).toEqual(expected);
  });
});
