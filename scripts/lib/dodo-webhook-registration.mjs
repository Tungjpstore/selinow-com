import { createHash } from "node:crypto";
import { URL } from "node:url";

const PROVIDER_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u;
const WEBHOOK_SECRET = /^(?:whsec_)?[A-Za-z0-9_+/=-]{16,512}$/u;

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function webhookRows(payload) {
  if (Array.isArray(payload)) return payload;
  const envelope = object(payload);
  for (const key of ["items", "data", "webhooks"]) {
    if (Array.isArray(envelope[key])) return envelope[key];
  }
  return [];
}

function webhookUrl(row) {
  const value = object(row).url;
  return typeof value === "string" ? value : null;
}

function webhookId(row) {
  const value = object(row).id;
  return typeof value === "string" && PROVIDER_REFERENCE.test(value) ? value : null;
}

async function requestJson(input) {
  let response;
  try {
    response = await input.fetcher(`${input.apiBaseUrl}${input.path}`, {
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      method: input.method,
    });
  } catch {
    throw new Error("dodo_webhook_provider_unavailable");
  }
  if (!response.ok) throw new Error(`dodo_webhook_provider_http_${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("dodo_webhook_provider_response_invalid");
  }
}

export function fingerprintDodoWebhookReference(scope, value) {
  if (!/^(?:endpoint|provider_webhook)$/u.test(scope) || typeof value !== "string" || value.length < 3 || value.length > 2048) {
    throw new Error("dodo_webhook_reference_invalid");
  }
  return createHash("sha256").update(`dodo-webhook-registration:v1:${scope}:${value}`).digest("hex");
}

export async function ensureDodoWebhook(input) {
  const endpoint = new URL(input.endpointUrl);
  if (endpoint.protocol !== "https:" || endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.hash.length > 0 || endpoint.search.length > 0) {
    throw new Error("dodo_webhook_endpoint_invalid");
  }
  const apiBaseUrl = input.apiBaseUrl.replace(/\/+$/u, "");
  const listed = await requestJson({ apiBaseUrl, apiKey: input.apiKey, fetcher: input.fetcher, method: "GET", path: "/webhooks" });
  const matching = webhookRows(listed).filter((row) => webhookUrl(row) === endpoint.toString());
  if (matching.length > 1) throw new Error("dodo_webhook_endpoint_duplicate");
  let id = matching.length === 1 ? webhookId(matching[0]) : null;
  let created = false;
  if (id === null && matching.length === 1) throw new Error("dodo_webhook_provider_response_invalid");
  if (id === null) {
    const createdWebhook = object(await requestJson({
      apiBaseUrl,
      apiKey: input.apiKey,
      body: { url: endpoint.toString() },
      fetcher: input.fetcher,
      method: "POST",
      path: "/webhooks",
    }));
    id = webhookId(createdWebhook);
    if (id === null) throw new Error("dodo_webhook_provider_response_invalid");
    created = true;
  }
  const secretPayload = object(await requestJson({
    apiBaseUrl,
    apiKey: input.apiKey,
    fetcher: input.fetcher,
    method: "GET",
    path: `/webhooks/${encodeURIComponent(id)}/secret`,
  }));
  const secret = [secretPayload.secret, secretPayload.signing_key, secretPayload.webhook_secret]
    .find((value) => typeof value === "string" && WEBHOOK_SECRET.test(value));
  if (typeof secret !== "string") throw new Error("dodo_webhook_signing_key_invalid");
  return {
    created,
    endpointFingerprintSha256: fingerprintDodoWebhookReference("endpoint", endpoint.toString()),
    providerWebhookFingerprintSha256: fingerprintDodoWebhookReference("provider_webhook", id),
    secret,
  };
}
