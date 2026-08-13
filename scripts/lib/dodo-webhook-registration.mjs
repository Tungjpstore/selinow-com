import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

const PROVIDER_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u;
const WEBHOOK_SECRET = /^(?:whsec_)?[A-Za-z0-9_+/=-]{16,512}$/u;
const REQUIRED_DODO_WEBHOOK_EVENTS = Object.freeze([
  "payment.failed",
  "payment.succeeded",
  "subscription.active",
  "subscription.cancelled",
  "subscription.expired",
  "subscription.failed",
  "subscription.on_hold",
  "subscription.plan_changed",
  "subscription.renewed",
  "subscription.updated",
]);
const WEBHOOK_EVENT_FIELDS = Object.freeze(["events", "event_types", "eventTypes", "filter_types", "filterTypes"]);
const UNUSABLE_WEBHOOK_STATUSES = new Set(["deleted", "disabled", "error", "failed", "inactive", "paused"]);
const REGISTRATION_LOCK_TTL_MS = 30_000;
const REGISTRATION_LOCK_ATTEMPTS = 500;

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

function assertExistingWebhookUsable(row) {
  const webhook = object(row);
  const status = typeof webhook.status === "string" ? webhook.status.trim().toLowerCase() : null;
  if (webhook.disabled === true || webhook.enabled === false || (status !== null && UNUSABLE_WEBHOOK_STATUSES.has(status))) {
    throw new Error("dodo_webhook_endpoint_unusable");
  }
  for (const field of WEBHOOK_EVENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(webhook, field)) continue;
    const declaredEvents = webhook[field];
    // Providers may represent an unrestricted event contract as null.
    if (declaredEvents === null) continue;
    if (!Array.isArray(declaredEvents) || declaredEvents.some((eventType) => typeof eventType !== "string")) {
      throw new Error("dodo_webhook_provider_response_invalid");
    }
    const eventTypes = new Set(declaredEvents);
    if (REQUIRED_DODO_WEBHOOK_EVENTS.some((eventType) => !eventTypes.has(eventType))) {
      throw new Error("dodo_webhook_event_contract_incomplete");
    }
  }
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

async function withRegistrationLease(input, operation) {
  const leasePath = input.lockPath;
  if (typeof leasePath !== "string" || leasePath.length < 1) return operation();
  for (let attempt = 0; attempt < REGISTRATION_LOCK_ATTEMPTS; attempt += 1) {
    const lease = {
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + REGISTRATION_LOCK_TTL_MS).toISOString(),
      id: randomUUID(),
      mode: "dodo_webhook_registration_lease",
      schemaVersion: 1,
    };
    try {
      await writeFile(leasePath, `${JSON.stringify(lease)}\n`, { flag: "wx", mode: 0o600 });
      try { return await operation(); } finally { await rm(leasePath, { force: true }); }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = true;
      try {
        const current = JSON.parse(await readFile(leasePath, "utf8"));
        stale = Date.parse(current.expiresAt ?? "") <= Date.now();
      } catch {
        // A missing or malformed lease is treated as abandoned.
      }
      if (stale) await rm(leasePath, { force: true });
      else await delay(2);
    }
  }
  throw new Error("dodo_webhook_registration_lock_timeout");
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
  const defaultLockPath = join(tmpdir(), `selinow-dodo-webhook-${createHash("sha256").update(`${apiBaseUrl}\n${endpoint.toString()}`).digest("hex")}.lock`);
  return withRegistrationLease({ lockPath: input.lockPath ?? defaultLockPath }, async () => {
    const listed = await requestJson({ apiBaseUrl, apiKey: input.apiKey, fetcher: input.fetcher, method: "GET", path: "/webhooks" });
  const matching = webhookRows(listed).filter((row) => webhookUrl(row) === endpoint.toString());
  if (matching.length > 1) throw new Error("dodo_webhook_endpoint_duplicate");
  if (matching.length === 1) assertExistingWebhookUsable(matching[0]);
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
  });
}
