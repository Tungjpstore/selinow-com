import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  configurePolicy: vi.fn(),
  consumeGrant: vi.fn(),
  createAsset: vi.fn(),
  env: {},
  authorizeUpload: vi.fn(),
  issueGrant: vi.fn(),
  listDownloads: vi.fn(),
  requireCsrf: vi.fn(),
  resolveShop: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({ requireCsrfSession: dependencies.requireCsrf }));
vi.mock("../../src/lib/commerce/private-file-fulfillment", () => ({
  configurePrivateFilePolicy: dependencies.configurePolicy,
  consumeWebsitePrivateDownloadGrant: dependencies.consumeGrant,
  authorizePrivateDigitalAssetUpload: dependencies.authorizeUpload,
  createPrivateDigitalAsset: dependencies.createAsset,
  issueWebsitePrivateDownloadGrant: dependencies.issueGrant,
  listWebsitePrivateDownloads: dependencies.listDownloads,
  MAX_PRIVATE_FILE_BYTES: 50 * 1024 * 1024,
}));
vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.env }));
vi.mock("../../src/lib/storefront/store", () => ({ resolveStorefrontShop: dependencies.resolveShop }));

import * as consumeRoute from "../../src/pages/api/store/orders/[orderPublicId]/downloads/grants/[grantId]/consume";
import * as grantRoute from "../../src/pages/api/store/orders/[orderPublicId]/downloads/[assetVersionId]/grant";
import * as listRoute from "../../src/pages/api/store/orders/[orderPublicId]/downloads";
import * as policyRoute from "../../src/pages/api/app/shops/[shopPublicId]/products/[productId]/private-file-policy";
import * as uploadRoute from "../../src/pages/api/app/shops/[shopPublicId]/assets/private-files";

const orderPublicId = "order_11111111-1111-4111-8111-111111111111";
const assetVersionId = "dav_22222222-2222-4222-8222-222222222222";
const orderItemId = "oit_88888888-8888-4888-8888-888888888888";
const grantId = "dgr_33333333-3333-4333-8333-333333333333";
const assetId = "das_55555555-5555-4555-8555-555555555555";
const productId = "prd_66666666-6666-4666-8666-666666666666";
const shopPublicId = "shop_77777777-7777-4777-8777-777777777777";
const orderToken = "order-access-token-1234567890";
const grantToken = `dgt_v1.${grantId}.grant-secret-123456789012345678901234567890123456789`;
const auth = { userId: "user-a" };
const shop = { id: "shop-a" };

function request(path: string, method: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://signal.example.test${path}`, { headers, method });
}

function context(routeRequest: Request, params: Record<string, string>, requestId = "request-private-download") {
  return {
    locals: { requestId },
    params,
    request: routeRequest,
  } as never;
}

beforeEach(() => {
  dependencies.configurePolicy.mockReset();
  dependencies.consumeGrant.mockReset();
  dependencies.createAsset.mockReset();
  dependencies.authorizeUpload.mockReset();
  dependencies.issueGrant.mockReset();
  dependencies.listDownloads.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.resolveShop.mockReset();
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.authorizeUpload.mockResolvedValue(shop.id);
  dependencies.resolveShop.mockResolvedValue(shop);
});

describe("seller private file route contracts", () => {
  it("requires a CSRF-authenticated session before reading or storing an upload", async () => {
    dependencies.requireCsrf.mockRejectedValueOnce(new AppError("csrf_invalid", 403));
    const uploadRequest = new Request(`https://app.example.test/api/app/shops/${shopPublicId}/assets/private-files`, {
      body: "private-pdf-bytes",
      headers: { "Content-Type": "application/pdf", "X-File-Name": "manual.pdf" },
      method: "POST",
    });

    const response = await uploadRoute.POST(context(uploadRequest, { shopPublicId }, "request-private-upload-csrf"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "csrf_invalid", ok: false });
    expect(dependencies.requireCsrf).toHaveBeenCalledWith(uploadRequest, dependencies.env);
    expect(dependencies.createAsset).not.toHaveBeenCalled();
  });

  it("reads raw upload metadata from headers and returns only safe asset metadata", async () => {
    dependencies.createAsset.mockResolvedValue({
      assetId,
      assetVersionId,
      byteSize: 17,
      contentSha256: "sha256-safe-metadata",
      contentType: "application/pdf",
      filename: "manual.pdf",
      objectKey: `private-digital-assets/internal/${assetVersionId}`,
      publicUrl: "https://unsafe-public-bucket.r2.dev/manual.pdf",
      version: 1,
    });
    const uploadRequest = new Request(`https://app.example.test/api/app/shops/${shopPublicId}/assets/private-files`, {
      body: "private-pdf-bytes",
      headers: { "Content-Type": "application/pdf", "X-File-Name": "manual.pdf" },
      method: "POST",
    });

    const response = await uploadRoute.POST(context(uploadRequest, { shopPublicId }, "request-private-upload"));

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      asset: {
        assetId,
        assetVersionId,
        byteSize: 17,
        contentSha256: "sha256-safe-metadata",
        contentType: "application/pdf",
        filename: "manual.pdf",
        version: 1,
      },
      ok: true,
      requestId: "request-private-upload",
    });
    expect(dependencies.createAsset).toHaveBeenCalledWith({
      bytes: new TextEncoder().encode("private-pdf-bytes"),
      contentType: "application/pdf",
      env: dependencies.env,
      filename: "manual.pdf",
      requestId: "request-private-upload",
      shopPublicId,
      userId: auth.userId,
    });
    expect(dependencies.authorizeUpload).toHaveBeenCalledWith({ env: dependencies.env, shopPublicId, userId: auth.userId });
  });

  it("authorizes the target shop and rejects oversized uploads before buffering", async () => {
    const uploadRequest = new Request(`https://app.example.test/api/app/shops/${shopPublicId}/assets/private-files`, {
      body: "small-body",
      headers: {
        "Content-Length": String(50 * 1024 * 1024 + 1),
        "Content-Type": "application/pdf",
        "X-File-Name": "manual.pdf",
      },
      method: "POST",
    });

    const response = await uploadRoute.POST(context(uploadRequest, { shopPublicId }, "request-private-upload-large"));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "validation_failed", issues: ["request_body_too_large"], ok: false });
    expect(dependencies.authorizeUpload).toHaveBeenCalledWith({ env: dependencies.env, shopPublicId, userId: auth.userId });
    expect(dependencies.createAsset).not.toHaveBeenCalled();
  });

  it("rejects unknown policy fields before configuring fulfillment", async () => {
    const policyRequest = new Request(`https://app.example.test/api/app/shops/${shopPublicId}/products/${productId}/private-file-policy`, {
      body: JSON.stringify({
        assetVersionId,
        grantTtlSeconds: 600,
        maxDownloads: 3,
        objectKey: "must-never-be-client-controlled",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const response = await policyRoute.POST(context(policyRequest, { productId, shopPublicId }, "request-private-policy-unknown"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "validation_failed",
      issues: ["unknown_field:objectKey"],
      ok: false,
    });
    expect(dependencies.configurePolicy).not.toHaveBeenCalled();
  });

  it("forwards typed private-file settings and returns a private no-store policy", async () => {
    dependencies.configurePolicy.mockResolvedValue({
      assetVersionId,
      entitlementTtlSeconds: 86_400,
      grantTtlSeconds: 600,
      id: "pfp_88888888-8888-4888-8888-888888888888",
      maxDownloads: 3,
      policyVersion: 1,
      productId,
    });
    const policyRequest = new Request(`https://app.example.test/api/app/shops/${shopPublicId}/products/${productId}/private-file-policy`, {
      body: JSON.stringify({ assetVersionId, entitlementTtlSeconds: 86_400, grantTtlSeconds: 600, maxDownloads: 3 }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const response = await policyRoute.POST(context(policyRequest, { productId, shopPublicId }, "request-private-policy"));

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toMatchObject({ ok: true, policy: { assetVersionId, productId } });
    expect(dependencies.configurePolicy).toHaveBeenCalledWith({
      assetVersionId,
      entitlementTtlSeconds: 86_400,
      env: dependencies.env,
      grantTtlSeconds: 600,
      maxDownloads: 3,
      productId,
      requestId: "request-private-policy",
      shopPublicId,
      userId: auth.userId,
    });
  });
});

describe("private download route contracts", () => {
  it("exposes list as GET and keeps the order token in a header", async () => {
    expect(listRoute.GET).toBeTypeOf("function");
    expect(Reflect.get(listRoute, "POST")).toBeUndefined();
    dependencies.listDownloads.mockResolvedValue([{
      assetVersionId,
      downloadCount: 0,
      entitlementExpiresAt: null,
      entitlementStatus: "active",
      filename: "manual.pdf",
      maxDownloads: 3,
      orderItemId: "ori_44444444-4444-4444-8444-444444444444",
      remainingDownloads: 3,
    }]);

    const response = await listRoute.GET(context(
      request(`/api/store/orders/${orderPublicId}/downloads`, "GET", { "X-Order-Access-Token": orderToken }),
      { orderPublicId },
    ));

    expect(response.status).toBe(200);
    expect(dependencies.listDownloads).toHaveBeenCalledWith({
      env: dependencies.env,
      orderPublicId,
      orderToken,
      shopId: shop.id,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
  });

  it("does not accept an order token from the list URL", async () => {
    const response = await listRoute.GET(context(
      request(`/api/store/orders/${orderPublicId}/downloads?orderToken=${encodeURIComponent(orderToken)}`, "GET"),
      { orderPublicId },
      "request-private-download-list-query-token",
    ));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "order_not_found", ok: false });
    expect(dependencies.listDownloads).not.toHaveBeenCalled();
  });

  it("exposes grant as POST and requires the order token in a header", async () => {
    expect(grantRoute.POST).toBeTypeOf("function");
    expect(Reflect.get(grantRoute, "GET")).toBeUndefined();
    dependencies.issueGrant.mockResolvedValue({
      assetVersionId,
      expiresAt: "2026-07-29T02:00:00.000Z",
      grantId,
      grantToken,
      remainingDownloads: 2,
    });

    const response = await grantRoute.POST(context(
      request(`/api/store/orders/${orderPublicId}/downloads/${assetVersionId}/grant`, "POST", {
        "Idempotency-Key": "private-download-grant-0001",
        "X-Order-Access-Token": orderToken,
        "X-Order-Item-Id": orderItemId,
      }),
      { assetVersionId, orderPublicId },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, grant: { grantId, grantToken } });
    expect(dependencies.issueGrant).toHaveBeenCalledWith({
      assetVersionId,
      env: dependencies.env,
      idempotencyKey: "private-download-grant-0001",
      orderItemId,
      orderPublicId,
      orderToken,
      requestId: "request-private-download",
      shopId: shop.id,
    });
  });

  it("does not accept an order token from the grant URL", async () => {
    const response = await grantRoute.POST(context(
      request(`/api/store/orders/${orderPublicId}/downloads/${assetVersionId}/grant?orderToken=${encodeURIComponent(orderToken)}`, "POST"),
      { assetVersionId, orderPublicId },
      "request-private-download-grant-query-token",
    ));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "order_not_found", ok: false });
    expect(dependencies.issueGrant).not.toHaveBeenCalled();
  });

  it("exposes consume as POST, requires both tokens in headers, and streams private bytes", async () => {
    expect(consumeRoute.POST).toBeTypeOf("function");
    expect(Reflect.get(consumeRoute, "GET")).toBeUndefined();
    dependencies.consumeGrant.mockResolvedValue({
      bytes: new TextEncoder().encode("private-file-bytes"),
      contentType: "application/pdf",
      filename: "manual.pdf",
    });

    const response = await consumeRoute.POST(context(
      request(`/api/store/orders/${orderPublicId}/downloads/grants/${grantId}/consume`, "POST", {
        "X-Delivery-Grant-Token": grantToken,
        "X-Order-Access-Token": orderToken,
      }),
      { grantId, orderPublicId },
    ));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("private-file-bytes");
    expect(response.headers.get("Accept-Ranges")).toBe("none");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(response.headers.get("Location")).toBeNull();
    expect([...response.headers.values()].join("\n")).not.toMatch(/https?:\/\/|r2\.dev/iu);
    expect(dependencies.consumeGrant).toHaveBeenCalledWith({
      env: dependencies.env,
      grantId,
      grantToken,
      orderPublicId,
      orderToken,
      requestId: "request-private-download",
      shopId: shop.id,
    });
  });

  it("does not accept either consume token from the URL", async () => {
    const response = await consumeRoute.POST(context(
      request(`/api/store/orders/${orderPublicId}/downloads/grants/${grantId}/consume?orderToken=${encodeURIComponent(orderToken)}&grantToken=${encodeURIComponent(grantToken)}`, "POST"),
      { grantId, orderPublicId },
      "request-private-download-consume-query-token",
    ));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "private_download_grant_not_found", ok: false });
    expect(dependencies.consumeGrant).not.toHaveBeenCalled();
  });
});
