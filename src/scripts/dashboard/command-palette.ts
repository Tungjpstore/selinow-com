/**
 * Command Palette Controller (⌘K)
 * Fast, keyboard-driven navigation across the Selinow Workspace.
 * Titles/categories resolve from the serialized console catalog copy (EX0);
 * results render through DOM APIs (no innerHTML).
 */

type PaletteCopy = Record<string, string>;

type NavDefinition = {
  categoryKey: string;
  id: string;
  keywords: string[];
  path: string;
  titleKey: string;
};

const NAV_DEFINITIONS: readonly NavDefinition[] = [
  { categoryKey: "console.palette.category.commerce", id: "overview", keywords: ["home", "dashboard", "doanh thu", "tong quan"], path: "/app", titleKey: "console.palette.item.overview" },
  { categoryKey: "console.palette.category.commerce", id: "orders", keywords: ["don hang", "order", "thanh toan"], path: "/app/orders", titleKey: "console.palette.item.orders" },
  { categoryKey: "console.palette.category.commerce", id: "bookings", keywords: ["lich", "booking", "hen"], path: "/app/bookings", titleKey: "console.palette.item.bookings" },
  { categoryKey: "console.palette.category.commerce", id: "customers", keywords: ["khach hang", "user", "buyer"], path: "/app/customers", titleKey: "console.palette.item.customers" },
  { categoryKey: "console.palette.category.catalog", id: "products", keywords: ["san pham", "product", "item"], path: "/app/products", titleKey: "console.palette.item.products" },
  { categoryKey: "console.palette.category.catalog", id: "inventory", keywords: ["kho", "key", "license", "ma"], path: "/app/inventory", titleKey: "console.palette.item.inventory" },
  { categoryKey: "console.palette.category.automation", id: "automation", keywords: ["rule", "auto", "quy tac"], path: "/app/automation", titleKey: "console.palette.item.automation" },
  { categoryKey: "console.palette.category.channels", id: "store", keywords: ["giao dien", "web", "template", "storefront"], path: "/app/store", titleKey: "console.palette.item.store" },
  { categoryKey: "console.palette.category.channels", id: "integrations", keywords: ["telegram", "bot", "zalo", "discord"], path: "/app/integrations", titleKey: "console.palette.item.integrations" },
  { categoryKey: "console.palette.category.channels", id: "payments", keywords: ["payos", "vietqr", "ngan hang"], path: "/app/payments", titleKey: "console.palette.item.payments" },
  { categoryKey: "console.palette.category.channels", id: "domains", keywords: ["domain", "cname", "dns", "cloudflare"], path: "/app/domains", titleKey: "console.palette.item.domains" },
  { categoryKey: "console.palette.category.settings", id: "onboarding", keywords: ["onboarding", "setup", "huong dan"], path: "/onboarding", titleKey: "console.palette.item.onboarding" },
  { categoryKey: "console.palette.category.settings", id: "members", keywords: ["member", "team", "nhan vien"], path: "/app/members", titleKey: "console.palette.item.members" },
  { categoryKey: "console.palette.category.settings", id: "security", keywords: ["bao mat", "2fa", "mat khau", "totp"], path: "/app/security", titleKey: "console.palette.item.security" },
  { categoryKey: "console.palette.category.settings", id: "billing", keywords: ["billing", "goi", "thanh toan saas"], path: "/app/billing", titleKey: "console.palette.item.billing" },
  { categoryKey: "console.palette.category.settings", id: "developer", keywords: ["api", "developer", "webhook", "token"], path: "/app/developer", titleKey: "console.palette.item.developer" },
  { categoryKey: "console.palette.category.settings", id: "data", keywords: ["audit", "log", "lich su", "xoa"], path: "/app/data", titleKey: "console.palette.item.data" },
];

export type CommandItem = {
  id: string;
  title: string;
  category: string;
  url: string;
  keywords: string[];
};

export class CommandPaletteController {
  private dialog: HTMLDialogElement | null = null;
  private input: HTMLInputElement | null = null;
  private resultsContainer: HTMLElement | null = null;
  private items: CommandItem[] = [];
  private selectedIndex = 0;
  private filteredItems: CommandItem[] = [];
  private copy: PaletteCopy = {};

  constructor() {
    this.dialog = document.querySelector<HTMLDialogElement>("[data-command-palette-dialog]");
    if (!this.dialog) return;

    this.input = this.dialog.querySelector<HTMLInputElement>("[data-command-palette-input]");
    this.resultsContainer = this.dialog.querySelector<HTMLElement>("[data-command-palette-results]");
    try {
      this.copy = JSON.parse(this.dialog.dataset.copy ?? "{}") as PaletteCopy;
    } catch {
      this.copy = {};
    }

    this.collectDefaultItems();
    this.bindEvents();
  }

  private collectDefaultItems(): void {
    const shopParam = document.body.dataset.selectedShopPublicId;
    const withShop = (path: string): string =>
      shopParam ? `${path}?shop=${encodeURIComponent(shopParam)}` : path;

    this.items = NAV_DEFINITIONS.map((definition) => ({
      category: this.copy[definition.categoryKey] ?? definition.categoryKey,
      id: definition.id,
      keywords: definition.keywords,
      title: this.copy[definition.titleKey] ?? definition.id,
      url: withShop(definition.path),
    }));
  }

  private bindEvents(): void {
    // Global Keyboard Shortcut ⌘K / Ctrl+K
    window.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        this.toggle();
      }
    });

    // Trigger button clicks
    for (const trigger of document.querySelectorAll<HTMLElement>("[data-command-palette-trigger]")) {
      trigger.addEventListener("click", (e) => {
        e.preventDefault();
        this.open();
      });
    }

    if (!this.dialog || !this.input) return;

    // Filter on typing
    this.input.addEventListener("input", (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement) this.filter(target.value.trim());
    });

    // Keyboard navigation within palette
    this.dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.close();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        this.navigate(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        this.navigate(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.selectCurrent();
      }
    });

    // Close on clicking backdrop
    this.dialog.addEventListener("click", (event) => {
      if (event.target === this.dialog) {
        this.close();
      }
    });
  }

  public open(): void {
    if (!this.dialog || !this.input) return;
    this.filter("");
    if (!this.dialog.open) {
      this.dialog.showModal();
    }
    this.input.value = "";
    this.input.focus();
  }

  public close(): void {
    if (!this.dialog) return;
    this.dialog.close();
  }

  public toggle(): void {
    if (this.dialog?.open) {
      this.close();
    } else {
      this.open();
    }
  }

  private filter(query: string): void {
    const q = query.toLowerCase();
    if (!q) {
      this.filteredItems = [...this.items];
    } else {
      this.filteredItems = this.items.filter((item) => {
        const matchTitle = item.title.toLowerCase().includes(q);
        const matchCategory = item.category.toLowerCase().includes(q);
        const matchKeywords = item.keywords.some((keyword) => keyword.toLowerCase().includes(q));
        return matchTitle || matchCategory || matchKeywords;
      });
    }
    this.selectedIndex = 0;
    this.render();
  }

  private navigate(delta: number): void {
    if (this.filteredItems.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.filteredItems.length) % this.filteredItems.length;
    this.render();
  }

  private selectCurrent(): void {
    const selected = this.filteredItems[this.selectedIndex];
    if (selected) {
      this.close();
      window.location.assign(selected.url);
    }
  }

  private render(): void {
    if (!this.resultsContainer) return;
    this.resultsContainer.replaceChildren();

    if (this.filteredItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "command-empty";
      const message = document.createElement("p");
      message.textContent = this.copy["console.palette.empty"] ?? "";
      empty.appendChild(message);
      this.resultsContainer.appendChild(empty);
      return;
    }

    for (const [index, item] of this.filteredItems.entries()) {
      const link = document.createElement("a");
      link.className = "command-item";
      if (index === this.selectedIndex) link.classList.add("is-selected");
      link.href = item.url;
      link.dataset.index = String(index);
      const body = document.createElement("div");
      body.className = "command-item__body";
      const title = document.createElement("span");
      title.className = "command-item__title";
      title.textContent = item.title;
      const category = document.createElement("span");
      category.className = "command-item__category";
      category.textContent = item.category;
      body.appendChild(title);
      body.appendChild(category);
      const enter = document.createElement("span");
      enter.className = "command-item__enter";
      enter.textContent = "↵";
      link.appendChild(body);
      link.appendChild(enter);
      link.addEventListener("click", () => {
        this.selectedIndex = index;
      });
      this.resultsContainer.appendChild(link);
    }
  }
}

// Auto-initialize when DOM is ready
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => new CommandPaletteController());
  } else {
    new CommandPaletteController();
  }
}
