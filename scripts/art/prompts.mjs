// LP Editorial Commerce — prompt library for the marketing art set.
// Rendered through the local nanobanana gateway (OpenAI-compatible
// /v1/images/generations, model nb/nanobanana-pro) by
// generate-marketing-art.mjs.
//
// The gateway normalizes sizes to three native aspect ratios:
//   landscape 3:2 → 1248x832, portrait 2:3 → 832x1248, square → 1024x1024
// so every entry declares one of those aspects instead of exact pixels.
// One recurring model identity is anchored by repeating the same descriptor
// in every prompt; wardrobe stays in the Selinow palette (violet / indigo /
// ivory) and every prompt asks for a tasteful, professional editorial look.

const MODEL_ANCHOR =
  "an elegant young Vietnamese female fashion model with long dark hair and natural makeup, " +
  "wearing a chic tailored deep-violet silk blazer over an ivory top";

const STYLE_TAIL =
  "Soft directional studio lighting, warm ivory tones, subtle film grain, " +
  "high-fashion magazine quality, photorealistic. Absolutely no text, no watermark, no logo.";

export const ART_SPEC = [
  {
    id: "hero-editorial-desktop",
    aspect: "landscape",
    prompt:
      `A high-fashion editorial photograph for a digital commerce brand: ${MODEL_ANCHOR}, ` +
      `standing confidently in the right third of the frame with a gentle smile, ` +
      `generous empty warm-ivory negative space filling the left half of the image. ${STYLE_TAIL}`,
    variants: [1248, 960, 720],
  },
  {
    id: "hero-editorial-mobile",
    aspect: "portrait",
    prompt:
      `A vertical editorial beauty portrait for a digital commerce brand: ${MODEL_ANCHOR}, ` +
      `head-and-shoulders framing centered with breathing room above her head, ` +
      `calm confident gaze toward the camera. ${STYLE_TAIL}`,
    variants: [832, 640, 480],
  },
  {
    id: "flow-conversation",
    aspect: "landscape",
    prompt:
      `A candid editorial lifestyle photograph: ${MODEL_ANCHOR}, seated at a bright minimal ` +
      `boutique desk, smiling while chatting with a customer on her smartphone, a slim laptop ` +
      `showing a tiny online shop beside her, morning light through linen curtains. ${STYLE_TAIL}`,
    variants: [1248, 832, 640],
  },
  {
    id: "flow-verify",
    aspect: "landscape",
    prompt:
      `A focused close-up editorial photograph: ${MODEL_ANCHOR}, holding a smartphone that glows ` +
      `with an abstract violet checkmark confirmation light, calm focused expression, warm ivory ` +
      `interior, shallow depth of field. The phone screen shows only a glowing abstract checkmark ` +
      `shape with no readable characters. ${STYLE_TAIL}`,
    variants: [1248, 832, 640],
  },
  {
    id: "flow-delivery",
    aspect: "landscape",
    prompt:
      `A joyful editorial lifestyle photograph: ${MODEL_ANCHOR}, delighted as she unwraps a small ` +
      `elegant indigo gift box revealing a glimmering translucent digital key card, gift ribbon ` +
      `loose on the table, ivory and violet styling. ${STYLE_TAIL}`,
    variants: [1248, 832, 640],
  },
  {
    id: "solutions-telegram",
    aspect: "landscape",
    prompt:
      `A fashion-tech editorial photograph: ${MODEL_ANCHOR}, managing customer conversations from ` +
      `her phone in a cozy studio, softly glowing abstract chat bubbles in violet and indigo ` +
      `floating around her. The bubbles are pure abstract shapes with no readable text. ${STYLE_TAIL}`,
    variants: [960, 640],
  },
  {
    id: "solutions-delivery",
    aspect: "landscape",
    prompt:
      `A futuristic yet warm editorial photograph: ${MODEL_ANCHOR}, handing a shimmering ` +
      `translucent digital key card toward the camera with elegant fingers, soft indigo gradient ` +
      `rim light behind her. ${STYLE_TAIL}`,
    variants: [960, 640],
  },
  {
    id: "solutions-license",
    aspect: "landscape",
    prompt:
      `An elegant fashion-tech editorial photograph: ${MODEL_ANCHOR}, arranging a minimal ` +
      `floating grid of glowing translucent inventory cards in violet and teal beside her, ` +
      `as if curating shelves of light. ${STYLE_TAIL}`,
    variants: [960, 640],
  },
  {
    id: "final-cta-wide",
    aspect: "landscape",
    prompt:
      `A cinematic high-fashion campaign photograph: ${MODEL_ANCHOR}, celebrating side by side ` +
      `with two elegantly dressed friends against a deep indigo-violet studio backdrop with soft ` +
      `rim light, confident joyful energy, wide group composition. ${STYLE_TAIL}`,
    variants: [1248, 960, 720],
  },
  {
    id: "auth-panel",
    aspect: "portrait",
    prompt:
      `A serene vertical editorial portrait: ${MODEL_ANCHOR}, looking slightly away from the ` +
      `camera with a gentle smile, soft lavender and ivory palette, calm inviting mood. ${STYLE_TAIL}`,
    variants: [832, 640],
  },
  {
    id: "og-editorial",
    aspect: "landscape",
    prompt:
      `A campaign cover photograph for a digital commerce brand: ${MODEL_ANCHOR}, poised in the ` +
      `right half of the frame with flowing violet silk fabric catching the light, large empty ` +
      `warm-ivory space across the left half of the image for a headline overlay. ${STYLE_TAIL}`,
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
