import type { APIRoute } from "astro";

import { getBindings } from "../../lib/platform/bindings";
import { getPublicMediaAsset } from "../../lib/media/assets";

const NOT_FOUND = new Response("Not found", {
  status: 404,
  headers: {
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Robots-Tag": "noindex, nofollow",
  },
});

/**
 * Public, host-agnostic storefront media. Assets are immutable per public id
 * (uploads always create a new asset), so responses cache aggressively. The
 * D1 row remains authoritative: soft-deleted assets 404 immediately.
 */
export const GET: APIRoute = async ({ params }) => {
  const publicId = typeof params.publicId === "string" ? params.publicId : "";
  if (publicId === "") return NOT_FOUND;
  const env = getBindings();
  const asset = await getPublicMediaAsset(env, publicId);
  if (asset === null) return NOT_FOUND;
  const object = await env.MEDIA.get(asset.objectKey);
  if (object === null) return NOT_FOUND;
  const body = await object.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": asset.contentType,
      "ETag": asset.objectEtag,
      "X-Content-Type-Options": "nosniff",
    },
  });
};
