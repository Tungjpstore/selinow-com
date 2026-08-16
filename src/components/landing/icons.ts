/**
 * Text-free inline SVG icon set for landing v4.
 *
 * Icons are stroke-only (1.8px, lucide-style per LANDING_V4_DESIGN_DIRECTION)
 * so they inherit `currentColor` and stay locale-neutral. Channel names and
 * readiness states remain in live HTML for localization.
 */

export const icon = (path: string, size = 18, strokeWidth = 1.8): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${String(size)}" height="${String(size)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${String(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;

export const channelIcons: Record<string, string> = {
  website: icon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 4 5.6 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.6-4-9s1.5-6.4 4-9z"/>'),
  telegram: icon('<path d="M21 4L3 11l5 2 2 6 3-4 5 4z"/><path d="M8 13l9-7-5 9"/>'),
  whatsapp: icon('<path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z"/><path d="M8.5 9.5c.5 3 3 5.5 6 6l1.5-1.5-2-1.5-1.5.8c-1-.5-2-1.5-2.5-2.5l.8-1.5-1.5-2z"/>'),
  zalo: icon('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 9v6M13 9v4a2 2 0 0 0 4 0V9"/>'),
  discord: icon('<path d="M8 12a1 1 0 1 0 0-.01"/><circle cx="16" cy="12" r="1"/><path d="M7 6c3-1.5 7-1.5 10 0l2 3a15 15 0 0 1 1.5 7c-1.5 1.5-3.5 2-3.5 2l-1-2a11 11 0 0 1-7 0l-1 2s-2-.5-3.5-2A15 15 0 0 1 5 9z"/>'),
  api: icon('<path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/>'),
};

export const proofCheck = icon('<path d="M20 6L9 17l-5-5"/>', 14);

export const trustIcons = [
  icon('<path d="M12 3l7 3v5c0 4.4-2.9 7.9-7 9-4.1-1.1-7-4.6-7-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  icon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 4 5.6 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.6-4-9s1.5-6.4 4-9z"/>'),
  icon('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'),
  icon('<path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/>'),
];

export const bentoIcons = [
  icon('<path d="M12 2l8 4v6c0 5-3.4 8.9-8 10-4.6-1.1-8-5-8-10V6z"/><path d="M8.5 12l2.5 2.5L16 9.5"/>', 22, 1.6),
  icon('<rect x="3" y="8" width="12" height="8" rx="2"/><path d="M15 11l6-3v8l-6-3"/><path d="M7 5.5h4M9 3.5v2"/>', 22, 1.6),
  icon('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>', 22, 1.6),
  icon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 4 5.6 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.6-4-9s1.5-6.4 4-9z"/>', 22, 1.6),
  icon('<path d="M3 12h4l2-7 4 14 2-7h6"/>', 22, 1.6),
  icon('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/><path d="M2 9h2M2 15h2M20 9h2M20 15h2M9 2v2M15 2v2M9 20v2M15 20v2"/>', 22, 1.6),
];

export const sparkGlyph = icon('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>', 16);

export const architectureGlyphs = [
  icon('<path d="M4 12h5l2-6 2 12 2-6h5"/>', 16),
  icon('<path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/>', 16),
  icon('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/>', 16),
];
