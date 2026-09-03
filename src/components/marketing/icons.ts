/**
 * Text-free inline SVG glyphs for marketing surfaces.
 *
 * Stroke-based, 1.7px, sized at call sites (16–22px UI / 24px diagram nodes).
 * Every glyph is decorative: callers must render with aria-hidden="true".
 */
const glyph = (paths: string, size = 18): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${String(size)}" height="${String(size)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  check: (size = 14) => glyph('<path d="M20 6L9 17l-5-5"/>', size),
  arrowRight: (size = 16) => glyph('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>', size),
  globe: (size = 18) => glyph('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 4 5.6 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.6-4-9s1.5-6.4 4-9z"/>', size),
  send: (size = 18) => glyph('<path d="M21 4L3 11l5 2 2 6 3-4 5 4z"/><path d="M8 13l9-7-5 9"/>', size),
  cart: (size = 18) => glyph('<circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M3 4h2l2.4 12h10.8L21 8H6"/>', size),
  receipt: (size = 18) => glyph('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6"/><path d="M9 12h6"/>', size),
  shieldCheck: (size = 18) => glyph('<path d="M12 3l7 3v5c0 4.4-2.9 7.9-7 9-4.1-1.1-7-4.6-7-9V6z"/><path d="M9 12l2 2 4-4"/>', size),
  key: (size = 18) => glyph('<circle cx="8" cy="15" r="4"/><path d="M10.9 12.1L20 3"/><path d="M16 7l3 3"/><path d="M18 5l3 3"/>', size),
  package: (size = 18) => glyph('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>', size),
  user: (size = 18) => glyph('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.4-3.4 4.4-5 8-5s6.6 1.6 8 5"/>', size),
  database: (size = 18) => glyph('<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6"/><path d="M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>', size),
  layers: (size = 18) => glyph('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>', size),
  pulse: (size = 18) => glyph('<path d="M3 12h4l2-6 4 12 2-6h6"/>', size),
  chat: (size = 18) => glyph('<path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z"/><path d="M9 11h6"/><path d="M9 14h3"/>', size),
  lock: (size = 18) => glyph('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', size),
  unlock: (size = 18) => glyph('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/>', size),
  clock: (size = 18) => glyph('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>', size),
  code: (size = 18) => glyph('<path d="M8 6l-5 6 5 6"/><path d="M16 6l5 6-5 6"/>', size),
  spark: (size = 16) => glyph('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>', size),
  eye: (size = 16) => glyph('<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/>', size),
} as const;

export type IconName = keyof typeof icons;
