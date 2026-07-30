import { canonicalizeHostname } from "./policy";

const DNS_QUERY_ORIGIN = "https://cloudflare-dns.com/dns-query";
const DNS_QUERY_TIMEOUT_MS = 5_000;
const DNS_MAX_RESPONSE_BYTES = 64 * 1024;
const OWNERSHIP_LABEL = "_selinow-verify";

export type CnameResolver = (hostname: string) => Promise<readonly string[]>;
export type TxtResolver = (hostname: string) => Promise<readonly string[]>;

export type DnsVerificationResult = {
  observedTargets: string[];
  status: "active" | "error" | "pending";
};

type DnsJsonAnswer = {
  data?: unknown;
  name?: unknown;
  type?: unknown;
};

type DnsJsonResponse = {
  Answer?: unknown;
  Status?: unknown;
};

function canonicalizeTarget(value: string): string | null {
  try {
    return canonicalizeHostname(value);
  } catch {
    return null;
  }
}

function canonicalizeOwnershipChallengeName(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/u, "");
  const prefix = `${OWNERSHIP_LABEL}.`;
  if (!trimmed.startsWith(prefix)) throw new Error("dns_lookup_failed");
  return `${prefix}${canonicalizeHostname(trimmed.slice(prefix.length))}`;
}

export async function resolveCnameTargets(hostname: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const query = new URL(DNS_QUERY_ORIGIN);
  query.searchParams.set("name", hostname);
  query.searchParams.set("type", "CNAME");

  let response: Response;
  try {
    response = await fetcher(query.toString(), {
      headers: { Accept: "application/dns-json" },
      method: "GET",
      signal: AbortSignal.timeout(DNS_QUERY_TIMEOUT_MS),
    });
  } catch {
    throw new Error("dns_lookup_failed");
  }
  if (!response.ok) throw new Error("dns_lookup_failed");

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > DNS_MAX_RESPONSE_BYTES) throw new Error("dns_lookup_failed");
  let payload: DnsJsonResponse;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid");
    payload = value;
  } catch {
    throw new Error("dns_lookup_failed");
  }

  if (payload.Status === 3) return [];
  if (payload.Status !== 0 || (payload.Answer !== undefined && !Array.isArray(payload.Answer))) throw new Error("dns_lookup_failed");
  if (!Array.isArray(payload.Answer)) return [];

  const normalizedHostname = canonicalizeHostname(hostname);
  return payload.Answer.flatMap((value): string[] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const answer = value as DnsJsonAnswer;
    if (answer.type !== 5 || typeof answer.name !== "string" || typeof answer.data !== "string") return [];
    const answerName = canonicalizeTarget(answer.name);
    const target = canonicalizeTarget(answer.data);
    return answerName === normalizedHostname && target !== null ? [target] : [];
  });
}

export async function resolveTxtRecords(hostname: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const normalizedHostname = canonicalizeOwnershipChallengeName(hostname);
  const query = new URL(DNS_QUERY_ORIGIN);
  query.searchParams.set("name", normalizedHostname);
  query.searchParams.set("type", "TXT");

  let response: Response;
  try {
    response = await fetcher(query.toString(), {
      headers: { Accept: "application/dns-json" },
      method: "GET",
      signal: AbortSignal.timeout(DNS_QUERY_TIMEOUT_MS),
    });
  } catch {
    throw new Error("dns_lookup_failed");
  }
  if (!response.ok) throw new Error("dns_lookup_failed");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > DNS_MAX_RESPONSE_BYTES) throw new Error("dns_lookup_failed");
  let payload: DnsJsonResponse;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid");
    payload = value;
  } catch {
    throw new Error("dns_lookup_failed");
  }

  if (payload.Status === 3) return [];
  if (payload.Status !== 0 || (payload.Answer !== undefined && !Array.isArray(payload.Answer))) throw new Error("dns_lookup_failed");
  if (!Array.isArray(payload.Answer)) return [];

  return payload.Answer.flatMap((value): string[] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const answer = value as DnsJsonAnswer;
    if (answer.type !== 16 || typeof answer.name !== "string" || typeof answer.data !== "string") return [];
    let answerName: string;
    try {
      answerName = canonicalizeOwnershipChallengeName(answer.name);
    } catch {
      return [];
    }
    if (answerName !== normalizedHostname) return [];
    return [answer.data.replace(/^"|"$/gu, "")];
  }).slice(0, 20);
}

export async function verifyCustomHostnameDns(input: {
  expectedTarget: string;
  hostname: string;
  resolver?: CnameResolver;
}): Promise<DnsVerificationResult> {
  let hostname: string;
  let expectedTarget: string;
  try {
    hostname = canonicalizeHostname(input.hostname);
    expectedTarget = canonicalizeHostname(input.expectedTarget);
  } catch {
    return { observedTargets: [], status: "error" };
  }

  try {
    const resolver = input.resolver ?? resolveCnameTargets;
    const observedTargets = Array.from(new Set((await resolver(hostname)).map(canonicalizeTarget).filter((value): value is string => value !== null))).slice(0, 20);
    return {
      observedTargets,
      status: observedTargets.includes(expectedTarget) ? "active" : "pending",
    };
  } catch {
    return { observedTargets: [], status: "error" };
  }
}

export async function verifyCustomDomainOwnership(input: {
  challengeName: string;
  expectedValue: string;
  resolver?: TxtResolver;
}): Promise<{ observedValues: string[]; status: "active" | "error" | "pending" }> {
  try {
    const challengeName = canonicalizeOwnershipChallengeName(input.challengeName);
    const resolver = input.resolver ?? resolveTxtRecords;
    const observedValues = Array.from(new Set(await resolver(challengeName))).filter((value) => value.length <= 512).slice(0, 20);
    return {
      observedValues,
      status: observedValues.includes(input.expectedValue) ? "active" : "pending",
    };
  } catch {
    return { observedValues: [], status: "error" };
  }
}
