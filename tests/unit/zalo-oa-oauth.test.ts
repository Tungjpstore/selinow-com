import { describe, expect, it } from "vitest";

import { createOpaqueToken } from "../../src/lib/core/ids";
import {
  createZaloOfficialAccountOAuthRequest,
  exchangeZaloOfficialAccountAuthorizationCode,
  refreshZaloOfficialAccountToken,
  verifyZaloOfficialAccountOAuthState,
  ZALO_OFFICIAL_ACCOUNT_OAUTH_AUTHORIZATION_ENDPOINT,
  ZALO_OFFICIAL_ACCOUNT_OAUTH_TOKEN_ENDPOINT,
} from "../../src/lib/channels/zalo-oa-oauth";

const APP_ID = "zalo-app-123";
const REDIRECT_URI = "https://app.selinow.com/api/channels/zalo-oa/callback";
const SECRET_KEY = "zalo-secret-key-123456";

describe("Zalo Official Account OAuth PKCE contract", () => {
  it("builds a tenant-supplied state and S256 authorization URL", async () => {
    const state = createOpaqueToken(32);
    const request = await createZaloOfficialAccountOAuthRequest({ appId: APP_ID, redirectUri: REDIRECT_URI, state });
    const url = new URL(request.authorizationUrl);
    expect(url.origin + url.pathname).toBe(ZALO_OFFICIAL_ACCOUNT_OAUTH_AUTHORIZATION_ENDPOINT);
    expect(url.searchParams.get("app_id")).toBe(APP_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(request.codeChallenge);
    expect(request.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(request.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(() => {
      verifyZaloOfficialAccountOAuthState({ expectedState: state, receivedState: state });
    }).not.toThrow();
  });

  it("rejects an OAuth callback state or redirect that is not bound to the request", async () => {
    const state = createOpaqueToken(32);
    expect(() => {
      verifyZaloOfficialAccountOAuthState({ expectedState: state, receivedState: createOpaqueToken(32) });
    }).toThrow(expect.objectContaining({ code: "zalo_oa_oauth_invalid", status: 400 }));
    await expect(createZaloOfficialAccountOAuthRequest({ appId: APP_ID, redirectUri: "http://localhost/callback", state })).rejects.toMatchObject({ code: "zalo_oa_oauth_invalid", status: 400 });
    await expect(createZaloOfficialAccountOAuthRequest({ appId: APP_ID, redirectUri: `${REDIRECT_URI}#fragment`, state })).rejects.toMatchObject({ code: "zalo_oa_oauth_invalid", status: 400 });
  });

  it("exchanges the one-use code without persisting provider response metadata", async () => {
    const codeVerifier = createOpaqueToken(32);
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestInit = init;
      return Promise.resolve(new Response(JSON.stringify({ access_token: "access-token-secret", expires_in: "90000", refresh_token: "refresh-token-secret" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }));
    };
    const result = await exchangeZaloOfficialAccountAuthorizationCode({
      appId: APP_ID,
      authorizationCode: "one-use-code",
      codeVerifier,
      redirectUri: REDIRECT_URI,
      secretKey: SECRET_KEY,
      fetcher,
    });
    expect(requestUrl).toBe(ZALO_OFFICIAL_ACCOUNT_OAUTH_TOKEN_ENDPOINT);
    expect(requestInit?.method).toBe("POST");
    expect(new Headers(requestInit?.headers).get("secret_key")).toBe(SECRET_KEY);
    const requestBody = typeof requestInit?.body === "string" ? requestInit.body : "";
    expect(requestBody).toContain(`code_verifier=${encodeURIComponent(codeVerifier)}`);
    expect(requestBody).toContain("grant_type=authorization_code");
    expect(requestBody).not.toContain("redirect_uri");
    expect(result).toEqual({ accessToken: "access-token-secret", refreshToken: "refresh-token-secret", expiresInSeconds: 90_000 });
  });

  it("rotates a one-use refresh token with the documented grant", async () => {
    let requestInit: RequestInit | undefined;
    const result = await refreshZaloOfficialAccountToken({
      appId: APP_ID,
      refreshToken: "refresh-token-secret",
      secretKey: SECRET_KEY,
      fetcher: (_input, init) => {
        requestInit = init;
        return Promise.resolve(new Response(JSON.stringify({ access_token: "next-access", expires_in: "90000", refresh_token: "next-refresh" }), { status: 200 }));
      },
    });
    const requestBody = typeof requestInit?.body === "string" ? requestInit.body : "";
    expect(requestBody).toContain("grant_type=refresh_token");
    expect(requestBody).toContain("refresh_token=refresh-token-secret");
    expect(result).toEqual({ accessToken: "next-access", refreshToken: "next-refresh", expiresInSeconds: 90_000 });
  });

  it("accepts the OA documentation's alternate expiry spelling only when unambiguous", async () => {
    const base = { appId: APP_ID, codeVerifier: createOpaqueToken(32), redirectUri: REDIRECT_URI, secretKey: SECRET_KEY };
    const response = (payload: Record<string, unknown>) => () => Promise.resolve(new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", ...payload }), { status: 200 }));
    await expect(exchangeZaloOfficialAccountAuthorizationCode({ ...base, authorizationCode: "code", fetcher: response({ expire_in: "90000" }) })).resolves.toMatchObject({ expiresInSeconds: 90_000 });
    await expect(exchangeZaloOfficialAccountAuthorizationCode({ ...base, authorizationCode: "code", fetcher: response({ expires_in: "90000", expire_in: "90000" }) })).resolves.toMatchObject({ expiresInSeconds: 90_000 });
    await expect(exchangeZaloOfficialAccountAuthorizationCode({ ...base, authorizationCode: "code", fetcher: response({ expires_in: "90000", expire_in: "90001" }) })).rejects.toMatchObject({ code: "zalo_oa_oauth_exchange_failed" });
  });

  it("fails closed on provider/network/response errors", async () => {
    const base = { appId: APP_ID, codeVerifier: createOpaqueToken(32), redirectUri: REDIRECT_URI, secretKey: SECRET_KEY };
    await expect(exchangeZaloOfficialAccountAuthorizationCode({ ...base, authorizationCode: "code", fetcher: () => Promise.reject(new Error("network")) })).rejects.toMatchObject({ code: "zalo_oa_oauth_exchange_failed", status: 502 });
    await expect(exchangeZaloOfficialAccountAuthorizationCode({ ...base, authorizationCode: "code", fetcher: () => Promise.resolve(new Response("provider-error", { status: 401 })) })).rejects.toMatchObject({ code: "zalo_oa_oauth_exchange_failed", status: 502 });
    await expect(exchangeZaloOfficialAccountAuthorizationCode({ ...base, authorizationCode: "code", fetcher: () => Promise.resolve(new Response(JSON.stringify({ access_token: "x", refresh_token: "y", expires_in: 0 }), { status: 200 })) })).rejects.toMatchObject({ code: "zalo_oa_oauth_exchange_failed", status: 502 });
  });
});
