import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  create: vi.fn(),
  env: {},
  list: vi.fn(),
  parse: vi.fn(),
  recentAuth: vi.fn(),
  requireCsrf: vi.fn(),
  authenticateSession: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  authenticateRequest: dependencies.authenticateSession,
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recentAuth,
}));

vi.mock("../../src/lib/channels/credential-routes", () => ({
  createChannelCredentialEnvelope: dependencies.create,
  listChannelCredentialProjections: dependencies.list,
  parseChannelCredentialEnvelopeInput: dependencies.parse,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

import { GET as listRoute, POST as createRoute } from "../../src/pages/api/app/shops/[shopPublicId]/channels/credentials";

const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";
const CONNECTION_PUBLIC_ID = "channel_00000000-0000-4000-8000-000000000002";
const auth = {
  authenticatedAt: "2026-07-29T06:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Owner",
  email: "owner@example.test",
  sessionId: "session-a",
  userId: "user-owner-a",
};
const envelope = {
  ciphertextB64: "A".repeat(43),
  connectionPublicId: CONNECTION_PUBLIC_ID,
  fingerprint: "B".repeat(43),
  ivB64: "C".repeat(16),
  keyVersion: "v1",
};
const credential = {
  connectionPublicId: CONNECTION_PUBLIC_ID,
  createdAt: "2026-07-29T06:00:00.000Z",
  credentialId: "ccred_00000000-0000-4000-8000-000000000003",
  keyVersion: "v1",
  providerCode: "whatsapp.cloud",
  status: "pending",
  version: 1,
};

function context(input: {
  body?: unknown;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  path: string;
}) {
  const headers = new Headers(input.headers);
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return {
    locals: { requestId: "request-channel-credential" },
    params: { shopPublicId: SHOP_PUBLIC_ID },
    request: new Request(`https://api.example.test${input.path}`, {
      ...(body === undefined ? {} : { body }),
      headers,
      method: input.method ?? "GET",
    }),
  };
}

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

beforeEach(() => {
  dependencies.authenticateSession.mockReset();
  dependencies.create.mockReset();
  dependencies.list.mockReset();
  dependencies.parse.mockReset();
  dependencies.recentAuth.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.authenticateSession.mockResolvedValue(auth);
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.parse.mockReturnValue(envelope);
  dependencies.list.mockResolvedValue([credential]);
  dependencies.create.mockResolvedValue({ credential, replayed: false });
});

describe("channel credential persistence routes", () => {
  it("requires recent authentication and returns only safe credential projections", async () => {
    const response = await listRoute(context({
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/channels/credentials`,
    }) as never);
    expect(dependencies.authenticateSession).toHaveBeenCalledWith(expect.any(Request), dependencies.env);
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth);
    expect(dependencies.list).toHaveBeenCalledWith({
      env: dependencies.env,
      shopPublicId: SHOP_PUBLIC_ID,
      userId: auth.userId,
    });
    expect(await response.json()).toMatchObject({ ok: true, credentials: [credential] });
    for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name), name).toBe(value);
  });

  it("creates a pending envelope only after CSRF/recent auth and idempotency", async () => {
    const response = await createRoute(context({
      body: envelope,
      headers: { "Idempotency-Key": "credential-create-001" },
      method: "POST",
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/channels/credentials`,
    }) as never);
    expect(dependencies.requireCsrf).toHaveBeenCalledWith(expect.any(Request), dependencies.env);
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth);
    expect(dependencies.parse).toHaveBeenCalledWith(envelope);
    expect(dependencies.create).toHaveBeenCalledWith({
      env: dependencies.env,
      envelope,
      idempotencyKey: "credential-create-001",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: auth.userId,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, replayed: false, credential: { status: "pending" } });
  });

  it("rejects plaintext or tenant override fields before persistence", async () => {
    const response = await createRoute(context({
      body: { ...envelope, appSecret: "plaintext-secret", shopId: "shop-other" },
      headers: { "Idempotency-Key": "credential-create-001" },
      method: "POST",
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/channels/credentials`,
    }) as never);
    expect(response.status).toBe(400);
    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it("returns 200 for an idempotent replay", async () => {
    dependencies.create.mockResolvedValueOnce({ credential, replayed: true });
    const response = await createRoute(context({
      body: envelope,
      headers: { "Idempotency-Key": "credential-create-001" },
      method: "POST",
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/channels/credentials`,
    }) as never);
    expect(response.status).toBe(200);
  });
});
