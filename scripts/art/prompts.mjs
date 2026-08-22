// LP Editorial Commerce — prompt library for the marketing art set (v3 scenes).
// Rendered through the local nanobanana gateway (OpenAI-compatible
// /v1/images/generations, model nb/nanobanana-pro) by
// generate-marketing-art.mjs.
//
// v3 pivot (owner review 2026-08-22): every render gets its OWN distinct
// scene tightly mirroring the section it lives in — no shared backdrop
// formula. Brand hues (violet / indigo / teal) stay as accent props so the
// campaign still reads as one family.
//
// The gateway normalizes sizes to three native aspect ratios:
//   landscape 3:2 → 1248x832, portrait 2:3 → 832x1248, square → 1024x1024
// so every entry declares one of those aspects instead of exact pixels.

const NO_TEXT = "No readable text anywhere, no watermark, no logo. Photorealistic, premium quality.";

export const ART_SPEC = [
  {
    // Hero — "Turn every conversation into a sale": the seller at the heart
    // of a multi-channel commerce operation, bright confident daylight.
    id: "hero-editorial-desktop",
    aspect: "landscape",
    prompt:
      "An elegant young Vietnamese female merchant with long dark hair, wearing a chic violet silk blouse, " +
      "standing confidently beside her bright modern boutique workspace: a slim laptop showing a glowing minimal " +
      "online storefront, a smartphone with floating chat notifications, and small neatly stacked indigo product " +
      "boxes with a translucent digital key card on top. Morning daylight through tall windows, ivory and soft " +
      "violet palette, airy and premium. " + NO_TEXT,
    variants: [1248, 960, 720],
  },
  {
    id: "hero-editorial-mobile",
    aspect: "portrait",
    prompt:
      "The same elegant young Vietnamese female merchant in a violet silk blouse, vertical portrait framing her " +
      "bright boutique workspace: she holds her smartphone toward the camera showing a glowing storefront with " +
      "floating chat bubbles, laptop and indigo product boxes softly blurred behind her, morning daylight, " +
      "confident warm smile. " + NO_TEXT,
    variants: [832, 640, 480],
  },
  {
    // Flow stage 1 — sales channel / conversation: intimate chat moment.
    id: "flow-conversation",
    aspect: "landscape",
    prompt:
      "Close lifestyle scene inside a cozy warmly-lit boutique corner in the afternoon: a shop owner's hands " +
      "typing a reply on a smartphone, chat bubbles glowing softly on the screen, a cup of tea and a small order " +
      "notebook on the wooden counter, golden window light, violet and amber tones, friendly personal mood. " + NO_TEXT,
    variants: [1248, 832, 640],
  },
  {
    // Flow stage 3 — PayOS verifies payment: macro precision, teal accent.
    id: "flow-verify",
    aspect: "landscape",
    prompt:
      "Macro product-style photograph on a clean pale-grey desk: one hand holding a smartphone displaying a single " +
      "glowing teal circular checkmark confirmation, subtle receipt-shaped light card floating beside the phone, " +
      "shallow depth of field, crisp minimal composition, teal and white palette, precise trustworthy mood. " + NO_TEXT,
    variants: [1248, 832, 640],
  },
  {
    // Flow stage 4 — delivery of the digital product: unboxing joy, evening.
    id: "flow-delivery",
    aspect: "landscape",
    prompt:
      "Warm evening living-room scene: a delighted young customer unwrapping a small deep-indigo gift box from " +
      "which a luminous translucent digital key card rises and glows like glass, ribbon loose on the sofa, soft " +
      "lamp light with violet and teal glow reflections, joyful celebratory mood. " + NO_TEXT,
    variants: [1248, 832, 640],
  },
  {
    // Solution — Telegram commerce: movement, notifications in transit.
    id: "solutions-telegram",
    aspect: "landscape",
    prompt:
      "Candid photograph of an elegant young Vietnamese female merchant in modern smart-casual attire walking " +
      "through a bright modern office corridor, checking her phone with a satisfied smile, a trail of softly " +
      "glowing blue chat bubbles and small order cards floating in the air behind her like notifications in " +
      "transit, daylight and glass, dynamic energetic mood. " + NO_TEXT,
    variants: [960, 640],
  },
  {
    // Solution — digital product delivery: product-hero macro of the key.
    id: "solutions-delivery",
    aspect: "landscape",
    prompt:
      "Studio product-hero macro: an open palm presenting a luminous translucent digital key card shaped like " +
      "crystal glass with violet core and teal edges, tiny spark of light traveling along the card, deep soft " +
      "indigo gradient background with gentle rim light, futuristic yet elegant. " + NO_TEXT,
    variants: [960, 640],
  },
  {
    // Solution — license key inventory: organized vault of keys.
    id: "solutions-license",
    aspect: "landscape",
    prompt:
      "An organized futuristic vault wall filled with neatly aligned glowing glass key cards like a library of " +
      "inventory slots, one hand sliding a violet-glowing card into an empty slot, deep indigo environment with " +
      "precise teal alignment lines, sense of order, security and control. " + NO_TEXT,
    variants: [960, 640],
  },
  {
    // Final CTA — start selling today: aspirational sunrise.
    id: "final-cta-wide",
    aspect: "landscape",
    prompt:
      "Wide aspirational photograph on a city rooftop at sunrise: a young Vietnamese female merchant and her " +
      "business partner standing side by side looking toward the horizon, a soft holographic rising revenue " +
      "chart and a small glowing storefront hovering in the morning haze ahead of them, golden-violet dawn sky, " +
      "confident hopeful energy, wide cinematic composition. " + NO_TEXT,
    variants: [1248, 960, 720],
  },
  {
    // Auth panel — sign in: calm start of the working day.
    id: "auth-panel",
    aspect: "portrait",
    prompt:
      "Serene vertical photograph of a tidy morning workspace by a window: a laptop half-open with a soft violet " +
      "login glow on its screen, a cup of coffee with light steam, a notebook and a single indigo product box, " +
      "gentle dawn light and lavender tones, calm inviting beginning-of-the-day mood, no people. " + NO_TEXT,
    variants: [832, 640],
  },
  {
    // OG cover — campaign summary with headline space on the left.
    id: "og-editorial",
    aspect: "landscape",
    prompt:
      "Campaign cover photograph: an elegant young Vietnamese female merchant in a violet silk blouse positioned " +
      "in the right half of the frame beside a glowing minimal online storefront hologram and floating chat " +
      "bubbles, generous clean ivory negative space across the entire left half of the image for a headline, " +
      "soft violet and teal accents, premium tech-commerce aesthetic. " + NO_TEXT,
    variants: [],
  },
]

// The gateway accepts the OpenAI-style size strings below; they map to the
// native aspect ratios described at the top of this file.
export const ASPECT_SIZE = {
  landscape: "1536x1024",
  portrait: "1024x1536",
  square: "1024x1024",
}

// AVIF/WebP quality knobs per format (kept modest so every committed variant
// stays around or below ~250KB).
export const ENCODE = {
  avif: { quality: 62, effort: 3 },
  webp: { quality: 78, effort: 4 },
}

export const FORMATS = ["avif", "webp"]
