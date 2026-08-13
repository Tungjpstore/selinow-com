const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const SAFE_NAME_PATTERN = /^[a-z][a-z0-9_:-]{1,80}$/u;
const APPROVED_STAGING_HOSTS = new Set([
  "staging.selinow.com",
  "app-staging.selinow.com",
  "api-staging.selinow.com",
  "signal.staging.selinow.com",
  "canvas.staging.selinow.com",
  "coming-soon.staging.selinow.com",
  "paused.staging.selinow.com",
]);

const READ_ONLY_METHODS = new Set(["GET", "HEAD"]);
const JSON_CONTENT_TYPES = ["application/json", "application/problem+json"];

function isJsonContentType(value) {
  const contentType = String(value ?? "").split(";", 1)[0].trim().toLowerCase();
  return JSON_CONTENT_TYPES.includes(contentType);
}

function isHtmlContentType(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase() === "text/html";
}

function safeHost(value) {
  return typeof value === "string" && APPROVED_STAGING_HOSTS.has(value);
}

function hostFromSpec(spec, hostname) {
  if (!Array.isArray(spec?.hostnames) || !spec.hostnames.includes(hostname)) {
    throw new Error(`staging_smoke_hostname_missing:${hostname}`);
  }
  return hostname;
}

/** Build the fixed, reviewed GET-only checks for a deployed staging Worker. */
export function createStagingPhaseASmokePlan(spec) {
  if (spec?.environment !== "staging") throw new Error("staging_smoke_spec_invalid");
  const storefrontHost = hostFromSpec(spec, "signal.staging.selinow.com");
  const platformHost = hostFromSpec(spec, "staging.selinow.com");
  const apiHost = hostFromSpec(spec, "api-staging.selinow.com");

  return {
    checks: [
      {
        contentType: "json",
        expectedStatuses: [200],
        kind: "health",
        method: "GET",
        name: "platform_health",
        requiredHeaders: ["cache-control"],
        requiredHeaderValues: { "cache-control": "no-store" },
        url: `https://${platformHost}/api/health`,
      },
      {
        bodyMarker: 'data-marketing-surface="solutions-hub"',
        contentType: "html",
        expectedStatuses: [200],
        kind: "marketing",
        method: "GET",
        name: "platform_marketing_solutions",
        requiredHeaders: [],
        url: `https://${platformHost}/solutions`,
      },
      {
        bodyMarker: "Not found",
        contentType: "text",
        expectedStatuses: [404],
        kind: "seo_boundary",
        method: "GET",
        name: "platform_llms_staging_closed",
        requiredHeaders: ["cache-control", "x-robots-tag"],
        requiredHeaderValues: {
          "cache-control": "private, no-store, max-age=0",
          "x-robots-tag": "noindex, nofollow",
        },
        url: `https://${platformHost}/llms.txt`,
      },
      {
        contentType: "json",
        expectedStatuses: [200],
        kind: "catalog",
        method: "GET",
        name: "website_catalog_read",
        requiredHeaders: ["cache-control", "vary"],
        url: `https://${storefrontHost}/api/store/catalog`,
      },
      {
        bodyMarker: "Signal Editor Lifetime",
        contentType: "html",
        expectedStatuses: [200],
        kind: "html",
        method: "GET",
        name: "website_storefront_home",
        requiredHeaders: ["cache-control"],
        url: `https://${storefrontHost}/`,
      },
      {
        bodyMarker: "Signal Editor Lifetime",
        contentType: "html",
        expectedStatuses: [200],
        kind: "html",
        method: "GET",
        name: "website_product_read",
        requiredHeaders: ["cache-control"],
        url: `https://${storefrontHost}/products/signal-editor-lifetime`,
      },
      {
        contentType: "any",
        expectedStatuses: [404, 405],
        kind: "method_boundary",
        method: "GET",
        name: "website_checkout_get_blocked",
        requiredHeaders: [],
        url: `https://${storefrontHost}/api/store/checkout`,
      },
      {
        contentType: "any",
        expectedStatuses: [404, 405],
        kind: "method_boundary",
        method: "GET",
        name: "telegram_webhook_get_blocked",
        requiredHeaders: [],
        url: `https://${apiHost}/webhooks/telegram/tgwh_00000000-0000-4000-8000-000000000000`,
      },
    ],
    environment: "staging",
    readOnly: true,
  };
}

export function validateStagingPhaseASmokePlan(plan) {
  if (plan?.environment !== "staging" || plan?.readOnly !== true) throw new Error("staging_smoke_plan_invalid");
  if (!Array.isArray(plan.checks) || plan.checks.length < 1 || plan.checks.length > 20) {
    throw new Error("staging_smoke_checks_invalid");
  }

  const names = new Set();
  const checks = plan.checks.map((check) => {
    if (!SAFE_NAME_PATTERN.test(check?.name ?? "") || names.has(check.name)) throw new Error("staging_smoke_check_name_invalid");
    names.add(check.name);
    const method = String(check.method ?? "").toUpperCase();
    if (!READ_ONLY_METHODS.has(method)) throw new Error(`staging_smoke_method_not_read_only:${check.name}`);
    let url;
    try {
      url = new globalThis.URL(check.url);
    } catch {
      throw new Error(`staging_smoke_url_invalid:${check.name}`);
    }
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash || !safeHost(url.hostname)) {
      throw new Error(`staging_smoke_url_invalid:${check.name}`);
    }
    if (!Array.isArray(check.expectedStatuses) || check.expectedStatuses.length === 0 || check.expectedStatuses.some((status) => !Number.isSafeInteger(status) || status < 200 || status > 599)) {
      throw new Error(`staging_smoke_status_invalid:${check.name}`);
    }
    if (!new Set(["any", "html", "json", "text"]).has(check.contentType)) throw new Error(`staging_smoke_content_type_invalid:${check.name}`);
    if (!Array.isArray(check.requiredHeaders) || check.requiredHeaders.some((header) => !/^[a-z][a-z0-9-]{1,80}$/u.test(header))) {
      throw new Error(`staging_smoke_header_invalid:${check.name}`);
    }
    if (check.requiredHeaderValues !== undefined
      && (check.requiredHeaderValues === null
        || typeof check.requiredHeaderValues !== "object"
        || Array.isArray(check.requiredHeaderValues))) {
      throw new Error(`staging_smoke_header_values_invalid:${check.name}`);
    }
    const requiredHeaderValues = Object.fromEntries(Object.entries(check.requiredHeaderValues ?? {}).map(([header, value]) => {
      if (!/^[a-z][a-z0-9-]{1,80}$/u.test(header) || typeof value !== "string" || value.length < 1 || value.length > 200) {
        throw new Error(`staging_smoke_header_values_invalid:${check.name}`);
      }
      return [header, value];
    }));
    if (check.bodyMarker !== undefined && (typeof check.bodyMarker !== "string" || check.bodyMarker.length < 2 || check.bodyMarker.length > 120)) {
      throw new Error(`staging_smoke_marker_invalid:${check.name}`);
    }
    return {
      bodyMarker: check.bodyMarker,
      contentType: check.contentType,
      expectedStatuses: [...check.expectedStatuses],
      kind: check.kind,
      method,
      name: check.name,
      requiredHeaders: [...check.requiredHeaders],
      requiredHeaderValues,
      url: url.toString(),
    };
  });
  return { checks, environment: "staging", readOnly: true };
}

async function readBoundedResponse(response) {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) return { body: "", tooLarge: true };
  if (response.body === null) return { body: "", tooLarge: false };
  const reader = response.body.getReader();
  const decoder = new globalThis.TextDecoder();
  let body = "";
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return { body: "", tooLarge: true };
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  return { body, tooLarge: false };
}

function inspectBody(check, body, contentType) {
  if (check.contentType === "json" && !isJsonContentType(contentType)) return "content_type_mismatch";
  if (check.contentType === "html" && !isHtmlContentType(contentType)) return "content_type_mismatch";
  if (check.contentType === "text" && String(contentType ?? "").split(";", 1)[0].trim().toLowerCase() !== "text/plain") return "content_type_mismatch";
  if (check.bodyMarker !== undefined && !body.includes(check.bodyMarker)) return "body_marker_missing";
  if (check.kind === "health" || check.kind === "catalog") {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return "json_invalid";
    }
    if (check.kind === "health") {
      if (payload?.ok !== true || payload?.service !== "selinow.com" || payload?.commerce?.contract !== "principal-channel-canonical-v1" || JSON.stringify(payload.commerce.channels) !== JSON.stringify(["telegram", "website"])) return "health_contract_mismatch";
    } else if (payload?.ok !== true || payload?.shop?.slug !== "signal" || !Array.isArray(payload.products) || !payload.products.some((product) => product?.slug === "signal-editor-lifetime" && Array.isArray(product.variants) && product.variants.length > 0)) {
      return "catalog_contract_mismatch";
    }
  }
  return null;
}

export async function runStagingPhaseASmoke(input) {
  const plan = validateStagingPhaseASmokePlan(input.plan);
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const actions = [];
  for (const check of plan.checks) {
    let response;
    try {
      response = await fetchImplementation(check.url, {
        headers: { Accept: "application/json, text/html", "Cache-Control": "no-cache" },
        method: check.method,
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      actions.push({ code: "request_failed", name: check.name, ok: false });
      continue;
    }
    const headersOk = check.requiredHeaders.every((name) => response.headers.has(name));
    if (!headersOk) {
      actions.push({ code: "required_header_missing", name: check.name, ok: false, status: response.status });
      continue;
    }
    const headerValuesOk = Object.entries(check.requiredHeaderValues ?? {}).every(([name, expected]) => (
      response.headers.get(name)?.trim().toLowerCase() === expected.trim().toLowerCase()
    ));
    if (!headerValuesOk) {
      actions.push({ code: "required_header_value_mismatch", name: check.name, ok: false, status: response.status });
      continue;
    }
    if (!check.expectedStatuses.includes(response.status)) {
      actions.push({ code: "status_mismatch", name: check.name, ok: false, status: response.status });
      continue;
    }
    let bounded;
    try {
      bounded = await readBoundedResponse(response);
    } catch {
      actions.push({ code: "response_read_failed", name: check.name, ok: false, status: response.status });
      continue;
    }
    if (bounded.tooLarge) {
      actions.push({ code: "response_too_large", name: check.name, ok: false, status: response.status });
      continue;
    }
    const bodyCode = inspectBody(check, bounded.body, response.headers.get("content-type"));
    actions.push({ code: bodyCode ?? "passed", name: check.name, ok: bodyCode === null, status: response.status });
  }
  return {
    actions,
    environment: "staging",
    ok: actions.every((action) => action.ok),
    readOnly: true,
  };
}
