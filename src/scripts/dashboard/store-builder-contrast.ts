import { contrastInk } from "../../lib/storefront/theme";

export const MIN_STOREFRONT_CONTRAST = 4.5;

export type StorefrontColorContrast = {
  ink: string;
  ratio: number;
  valid: boolean;
};

export type StorefrontContrastValidation = {
  accent: StorefrontColorContrast;
  brand: StorefrontColorContrast;
  valid: boolean;
};

function relativeLuminance(color: string): number {
  const value = color.replace("#", "");
  if (!/^[0-9A-F]{6}$/iu.test(value)) return 0;
  const channels = [0, 2, 4]
    .map((index) => Number.parseInt(value.slice(index, index + 2), 16) / 255)
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function colorContrast(background: string): StorefrontColorContrast {
  const ink = contrastInk(background);
  const backgroundLuminance = relativeLuminance(background);
  const inkLuminance = relativeLuminance(ink);
  const ratio = (Math.max(backgroundLuminance, inkLuminance) + 0.05)
    / (Math.min(backgroundLuminance, inkLuminance) + 0.05);
  return { ink, ratio, valid: ratio >= MIN_STOREFRONT_CONTRAST };
}

export function validateStorefrontContrast(primaryColor: string, accentColor: string): StorefrontContrastValidation {
  const brand = colorContrast(primaryColor);
  const accent = colorContrast(accentColor);
  return { accent, brand, valid: brand.valid && accent.valid };
}
