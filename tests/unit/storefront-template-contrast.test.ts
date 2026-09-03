import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * VR4 contrast gate (CD program): every storefront template's feel-token
 * palette must keep body-size text at WCAG AA 4.5:1 on the opaque surfaces it
 * paints (panel, nested panel, field). Template sheets only override tokens;
 * anything they do not override inherits the swift baseline below (the
 * resolved values of the shared :root layer in storefront.css). Merchant
 * brand/ink pairs are excluded — the seller-side contrast clamp owns those,
 * and protected stock/payment tints are intentionally out of scope.
 */

const BASELINE = {
  "--tmpl-field-bg": "#ffffff",
  "--tmpl-panel-bg-solid": "#ffffff",
  "--tmpl-panel-nested-bg": "#f8fafc",
  "--tmpl-text": "#0b1020",
  "--tmpl-text-2": "#475569",
  "--tmpl-text-3": "#64748b",
} as const;

const TEMPLATE_SHEETS = ["pulse", "desk", "aurora", "metro", "bustle", "serenity", "craft", "clinic"] as const;
const SURFACE_TOKENS = ["--tmpl-panel-bg-solid", "--tmpl-panel-nested-bg", "--tmpl-field-bg"] as const;
const TEXT_TOKENS = ["--tmpl-text", "--tmpl-text-2", "--tmpl-text-3"] as const;

function parseHex(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/iu.exec(value.trim());
  if (match === null) return null;
  const hex = match[1] as string;
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

function channel(channelValue: number): number {
  return channelValue <= 0.03928 ? channelValue / 12.92 : ((channelValue + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: [number, number, number]): number {
  const [red, green, blue] = rgb.map(channel) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const fore = parseHex(foreground);
  const back = parseHex(background);
  if (fore === null || back === null) throw new Error(`contrast gate: unparseable color pair ${foreground} on ${background}`);
  const foreLuminance = luminance(fore);
  const backLuminance = luminance(back);
  const lighter = Math.max(foreLuminance, backLuminance);
  const darker = Math.min(foreLuminance, backLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function templateTokens(templateId: string): Map<string, string> {
  const resolved = new Map<string, string>(Object.entries(BASELINE));
  if (templateId === "swift") return resolved;
  const sheet = readFileSync(`src/styles/storefront/templates/${templateId}.css`, "utf8");
  const blockMatch = new RegExp(`html\\[data-storefront-template="${templateId}"\\]\\s*\\{([\\s\\S]*?)\\}`, "u").exec(sheet);
  if (blockMatch === null) throw new Error(`contrast gate: ${templateId} sheet has no token block`);
  for (const declaration of blockMatch[1]?.split(";") ?? []) {
    const match = /(--tmpl-[a-z0-9-]+)\s*:\s*([^;]+)/u.exec(declaration);
    if (match === null) continue;
    const [, token, rawValue] = match as unknown as [string, string, string];
    const value = rawValue.trim();
    // Only literal hex overrides count; var() references resolve to the
    // baseline value they were defined to mirror in the shared sheet.
    if (parseHex(value) !== null) resolved.set(token, value);
  }
  return resolved;
}

const CASES: Array<{ surface: string; template: string; text: string }> = [];
for (const template of ["swift", ...TEMPLATE_SHEETS]) {
  for (const text of TEXT_TOKENS) {
    for (const surface of SURFACE_TOKENS) {
      CASES.push({ surface, template, text });
    }
  }
}

describe("storefront template contrast gate (VR4)", () => {
  it.each(CASES)("keeps $template $text AA-readable on $surface", ({ surface, template, text }) => {
    const tokens = templateTokens(template);
    const textValue = tokens.get(text);
    const surfaceValue = tokens.get(surface);
    if (textValue === undefined || surfaceValue === undefined) throw new Error(`contrast gate: missing token for ${template}`);
    const ratio = contrastRatio(textValue, surfaceValue);
    expect(ratio, `${template}: ${text} ${textValue} on ${surface} ${surfaceValue}`).toBeGreaterThanOrEqual(4.5);
  });

  it("covers every shipped template sheet with a token block", () => {
    for (const template of TEMPLATE_SHEETS) {
      expect(() => templateTokens(template), template).not.toThrow();
    }
  });
});
