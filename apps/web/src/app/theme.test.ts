import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLORS, contrast, ground, mix, MIXES, NAV_ALPHA, PAIRINGS, THEME, type ColorName } from "./theme";

const read = (relative: string) => readFileSync(path.resolve(import.meta.dirname, relative), "utf8");
const stylesheet = read("./globals.css");
const design = read("../../../../docs/DESIGN.md");

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
});

describe("contrast, WCAG 2.1 AA", () => {
  it.each(PAIRINGS.map((pair) => [pair.text, pair.on, pair.min] as const))("%s on %s is at least %s:1", (text, on, min) => {
    const colors = declared as Record<ColorName, string>;
    expect(contrast(colors[text], ground(on, colors, declaredNavAlpha))).toBeGreaterThanOrEqual(min);
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
});
