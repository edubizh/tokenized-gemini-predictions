// The palette as data, for the contrast test and the reference page. The browser reads the colours
// from globals.css; theme.test.ts keeps this file, the stylesheet and docs/DESIGN.md in agreement.

export const COLORS = {
  forest: "#173B2A",
  jade: "#0A7F56",
  peach: "#FEF3EB",
  white: "#FFFFFF",
  "forest-soft": "#536E61",
  edge: "#788D83",
  line: "#E3E7E5",
  "forest-hover": "#335344",
  "jade-hover": "#0C754F",
  "jade-tint": "#E2F0EB",
  "jade-tint-hover": "#CEE5DD",
  clay: "#9C4A3C",
  "clay-tint": "#F3E9E8",
} as const;

export type ColorName = keyof typeof COLORS;

/** The four theme colours. Every other colour is a mix of these, apart from the clay exception. */
export const THEME = ["forest", "jade", "peach", "white"] as const satisfies readonly ColorName[];

/** A derived colour: this many percent of the first colour, the rest of the second, in sRGB. */
export const MIXES: Partial<Record<ColorName, readonly [ColorName, number, ColorName]>> = {
  "forest-soft": ["forest", 74, "white"],
  edge: ["forest", 58, "white"],
  line: ["forest", 12, "white"],
  "forest-hover": ["forest", 88, "white"],
  "jade-hover": ["jade", 85, "forest"],
  "jade-tint": ["jade", 12, "white"],
  "jade-tint-hover": ["jade", 20, "white"],
  "clay-tint": ["clay", 12, "white"],
};

/** Opacity of the navbar's peach fill (`--nav-alpha`). */
export const NAV_ALPHA = 0.8;

/** A background: a colour, or the navbar's fill over a forest area, the darkest thing beneath it. */
export type Ground = ColorName | "nav-worst";

export interface Pairing {
  text: ColorName;
  on: Ground;
  /** WCAG 2.1 AA: 4.5 for text, 3 for large text, control boundaries and marks. */
  min: 3 | 4.5;
  use: string;
}

/** Every pairing the design system uses. The same list, with its figures, is in docs/DESIGN.md. */
export const PAIRINGS: readonly Pairing[] = [
  { text: "forest", on: "white", min: 4.5, use: "Text on surfaces" },
  { text: "forest", on: "peach", min: 4.5, use: "Text on the page" },
  { text: "forest-soft", on: "white", min: 4.5, use: "Secondary text on surfaces" },
  { text: "forest-soft", on: "peach", min: 4.5, use: "Secondary text on the page" },
  { text: "white", on: "forest", min: 4.5, use: "Primary button, selected choice" },
  { text: "white", on: "forest-hover", min: 4.5, use: "The same under the pointer" },
  { text: "white", on: "jade", min: 4.5, use: "Selected Yes" },
  { text: "white", on: "jade-hover", min: 4.5, use: "Selected Yes under the pointer" },
  { text: "jade", on: "white", min: 4.5, use: "Prices, the Yes boundary, the focus ring" },
  { text: "jade", on: "peach", min: 4.5, use: "Prices and the focus ring on the page, the live dot" },
  { text: "jade", on: "jade-tint", min: 3, use: "The Yes boundary against its own fill, marks in a positive notice" },
  { text: "forest", on: "jade-tint", min: 4.5, use: "Yes at rest, positive notice and badge" },
  { text: "forest", on: "jade-tint-hover", min: 4.5, use: "Yes under the pointer" },
  { text: "forest", on: "line", min: 4.5, use: "Neutral badge" },
  { text: "clay", on: "white", min: 4.5, use: "Error text on surfaces" },
  { text: "clay", on: "peach", min: 4.5, use: "Error text on the page" },
  { text: "clay", on: "clay-tint", min: 4.5, use: "Title of an error notice" },
  { text: "forest", on: "clay-tint", min: 4.5, use: "Body of an error notice" },
  { text: "edge", on: "white", min: 3, use: "Control boundaries on surfaces" },
  { text: "edge", on: "peach", min: 3, use: "Control boundaries on the page" },
  { text: "forest", on: "nav-worst", min: 4.5, use: "Navbar text over the darkest content" },
  { text: "jade", on: "nav-worst", min: 3, use: "Navbar marks over the darkest content" },
];

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16)) as [number, number, number];
}

/** `percent` of `a` and the rest of `b`, channel by channel in sRGB, as `color-mix(in srgb)` does. */
export function mix(a: string, b: string, percent: number): string {
  const [from, to] = [channels(a), channels(b)];
  const mixed = from.map((value, index) => Math.round((value * percent + to[index]! * (100 - percent)) / 100));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** The solid colour a ground stands for, given the colours and the navbar's opacity in use. */
export function ground(name: Ground, colors: Record<ColorName, string> = COLORS, navAlpha = NAV_ALPHA): string {
  return name === "nav-worst" ? mix(colors.peach, colors.forest, navAlpha * 100) : colors[name];
}
