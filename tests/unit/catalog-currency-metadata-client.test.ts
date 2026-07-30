import { afterEach, describe, expect, it, vi } from "vitest";

type Listener = () => void;

type FakeElement = {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  dataset: Record<string, string>;
  disabled: boolean;
  querySelector: (selector: string) => FakeElement | null;
  reportValidity?: () => boolean;
  textContent: string | null;
};

function button(): FakeElement & { listeners: Map<string, Listener> } {
  const listeners = new Map<string, Listener>();
  return {
    addEventListener(type, listener) {
      listeners.set(type, typeof listener === "function" ? listener as Listener : () => undefined);
    },
    dataset: {},
    disabled: false,
    listeners,
    querySelector: () => null,
    textContent: null,
  };
}

function documentFor(elements: ReadonlyMap<string, FakeElement>): Document {
  return {
    cookie: "",
    documentElement: { lang: "en" },
    querySelector: (selector: string) => elements.get(selector) ?? null,
    querySelectorAll: () => [],
  } as unknown as Document;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("product currency metadata client guard", () => {
  it("does not attach product or variant mutation handlers when currency metadata is missing or unsupported", async () => {
    const dialog = button();
    dialog.dataset = { csrfCookieName: "csrf", shopPublicId: "shop-a" };
    dialog.reportValidity = () => true;
    const openButton = button();
    const form = button();
    form.reportValidity = () => true;
    const createButton = button();
    const feedback = button();
    const editor = button();
    editor.dataset = { csrfCookieName: "csrf", productId: "product-a", shopPublicId: "shop-a", defaultCurrency: "GBP" };
    const saveButton = button();
    const archiveButton = button();
    const editorFeedback = button();
    const elements = new Map<string, FakeElement>([
      ["[data-product-dialog]", dialog],
      ["[data-open-product-form]", openButton],
      ["[data-product-form]", form],
      ["[data-form-feedback]", feedback],
      ["[data-create-product]", createButton],
      ["[data-product-editor]", editor],
      ["[data-save-product]", saveButton],
      ["[data-archive-product]", archiveButton],
      ["[data-editor-feedback]", editorFeedback],
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("document", documentFor(elements));
    vi.stubGlobal("fetch", fetchMock);

    await import("../../src/scripts/dashboard/products");

    expect(createButton.disabled).toBe(true);
    expect(saveButton.disabled).toBe(true);
    expect(archiveButton.disabled).toBe(true);
    expect(createButton.listeners.has("click")).toBe(false);
    expect(saveButton.listeners.has("click")).toBe(false);
    expect(archiveButton.listeners.has("click")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
