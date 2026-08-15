import { afterEach, describe, expect, it, vi } from "vitest";

type MiniElement = {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  classList: { toggle: ReturnType<typeof vi.fn> };
  dataset: Record<string, string>;
  disabled: boolean;
  hidden: boolean;
  querySelector: (selector: string) => MiniElement | null;
  querySelectorAll: (selector: string) => MiniElement[];
  setAttribute: ReturnType<typeof vi.fn>;
  textContent: string | null;
};

function element(dataset: Record<string, string> = {}): MiniElement {
  return {
    addEventListener: vi.fn(),
    classList: { toggle: vi.fn() },
    dataset,
    disabled: false,
    hidden: false,
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute: vi.fn(),
    textContent: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("catalog visibility client", () => {
  it("keeps provider-pending channels disabled even when stale data says visible", async () => {
    const feedback = element();
    const retry = element();
    retry.hidden = true;
    const state = element();
    const toggle = element({
      channelCode: "telegram.mini_app",
      productId: "prd_11111111-1111-4111-8111-111111111111",
      providerPending: "true",
      version: "0",
      visible: "false",
    });
    toggle.disabled = true;
    toggle.querySelector = (selector) => selector === "[data-visibility-state]" ? state : null;
    const panel = element({ csrfCookieName: "csrf", shopPublicId: "shop-public-a" });
    panel.querySelector = (selector) => selector === "[data-channel-visibility-feedback]"
      ? feedback
      : selector === "[data-channel-visibility-retry]" ? retry : null;
    panel.querySelectorAll = (selector) => selector === "[data-visibility-toggle]" ? [toggle] : [];
    const documentMock = {
      cookie: "",
      documentElement: { lang: "en" },
      querySelector: (selector: string) => selector === "[data-channel-visibility-panel]" ? panel : null,
      querySelectorAll: () => [],
    } as unknown as Document;
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        visibility: [{
          channelCode: "telegram.mini_app",
          productId: "prd_11111111-1111-4111-8111-111111111111",
          status: "visible",
          version: 7,
        }],
      }),
      ok: true,
    });
    vi.stubGlobal("document", documentMock);
    vi.stubGlobal("fetch", fetchMock);

    await import("../../src/scripts/dashboard/products");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toggle.disabled).toBe(true);
    expect(toggle.dataset.visible).toBe("false");
    expect(toggle.dataset.version).toBe("7");
    expect(state.textContent).toBe("Provider pending");
    expect(toggle.classList.toggle).toHaveBeenCalledWith("is-visible", false);
  });

  it("keeps controls disabled and offers retry when the initial read fails", async () => {
    const feedback = element();
    const retry = element();
    retry.hidden = true;
    const toggle = element({ channelCode: "website", productId: "prd_11111111-1111-4111-8111-111111111111", version: "0", visible: "false" });
    const panel = element({ csrfCookieName: "csrf", shopPublicId: "shop-public-a" });
    panel.querySelector = (selector) => selector === "[data-channel-visibility-feedback]"
      ? feedback
      : selector === "[data-channel-visibility-retry]" ? retry : null;
    panel.querySelectorAll = (selector) => selector === "[data-visibility-toggle]" ? [toggle] : [];
    const documentMock = {
      cookie: "",
      documentElement: { lang: "en" },
      querySelector: (selector: string) => selector === "[data-channel-visibility-panel]" ? panel : null,
      querySelectorAll: () => [],
    } as unknown as Document;
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({ code: "provider_unavailable" }) });
    vi.stubGlobal("document", documentMock);
    vi.stubGlobal("fetch", fetchMock);

    await import("../../src/scripts/dashboard/products");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledWith("/api/app/shops/shop-public-a/catalog/visibility", { credentials: "same-origin" });
    expect(toggle.disabled).toBe(true);
    expect(retry.hidden).toBe(false);
  });
});
