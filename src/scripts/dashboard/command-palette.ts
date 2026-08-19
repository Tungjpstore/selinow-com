/**
 * Command Palette Controller (⌘K)
 * Fast, keyboard-driven navigation across the Selinow Workspace.
 */

export type CommandItem = {
  id: string;
  title: string;
  category: string;
  url: string;
  icon?: string;
  keywords?: string[];
};

export class CommandPaletteController {
  private dialog: HTMLDialogElement | null = null;
  private input: HTMLInputElement | null = null;
  private resultsContainer: HTMLElement | null = null;
  private items: CommandItem[] = [];
  private selectedIndex = 0;
  private filteredItems: CommandItem[] = [];

  constructor() {
    this.dialog = document.querySelector<HTMLDialogElement>("[data-command-palette-dialog]");
    if (!this.dialog) return;

    this.input = this.dialog.querySelector<HTMLInputElement>("[data-command-palette-input]");
    this.resultsContainer = this.dialog.querySelector<HTMLElement>("[data-command-palette-results]");

    this.collectDefaultItems();
    this.bindEvents();
  }

  private collectDefaultItems(): void {
    const shopParam = document.body.dataset.selectedShopPublicId;
    const withShop = (path: string): string =>
      shopParam ? `${path}?shop=${encodeURIComponent(shopParam)}` : path;

    this.items = [
      // Commerce
      { id: "overview", title: "Tổng quan Dashboard", category: "Kinh doanh", url: withShop("/app"), keywords: ["home", "dashboard", "doanh thu"] },
      { id: "orders", title: "Quản lý Đơn hàng", category: "Kinh doanh", url: withShop("/app/orders"), keywords: ["don hang", "order", "thanh toan"] },
      { id: "bookings", title: "Lịch hẹn & Bookings", category: "Kinh doanh", url: withShop("/app/bookings"), keywords: ["lich", "booking", "hen"] },
      { id: "customers", title: "Khách hàng", category: "Kinh doanh", url: withShop("/app/customers"), keywords: ["khach hang", "user", "buyer"] },

      // Catalog & Inventory
      { id: "products", title: "Danh mục Sản phẩm", category: "Sản phẩm & Kho", url: withShop("/app/products"), keywords: ["san pham", "product", "item"] },
      { id: "inventory", title: "Kho Mã kích hoạt & License Keys", category: "Sản phẩm & Kho", url: withShop("/app/inventory"), keywords: ["kho", "key", "license", "ma"] },

      // Automation
      { id: "automation", title: "Quy tắc Tự động hóa", category: "Tự động hóa", url: withShop("/app/automation"), keywords: ["rule", "auto", "quy tac"] },

      // Channels & Payments
      { id: "store", title: "Thiết kế Storefront Website", category: "Kênh bán", url: withShop("/app/store"), keywords: ["giao dien", "web", "template"] },
      { id: "integrations", title: "Kênh Bot Telegram, Zalo, Discord", category: "Kênh bán", url: withShop("/app/integrations"), keywords: ["telegram", "bot", "zalo", "discord"] },
      { id: "payments", title: "Cổng VietQR & PayOS", category: "Kênh bán", url: withShop("/app/payments"), keywords: ["payos", "vietqr", "ngan hang"] },
      { id: "domains", title: "Tên miền Tuỳ chỉnh", category: "Kênh bán", url: withShop("/app/domains"), keywords: ["domain", "cname", "dns", "cloudflare"] },

      // Settings
      { id: "onboarding", title: "Hướng dẫn & Setup Readiness", category: "Cài đặt", url: withShop("/onboarding"), keywords: ["onboarding", "setup", "huong dan"] },
      { id: "members", title: "Thành viên & Phân quyền", category: "Cài đặt", url: withShop("/app/members"), keywords: ["member", "team", "nhan vien"] },
      { id: "security", title: "Bảo mật & Xác thực 2FA", category: "Cài đặt", url: withShop("/app/security"), keywords: ["bao mat", "2fa", "mat khau", "totp"] },
      { id: "billing", title: "Gói cước & Đăng ký SaaS", category: "Cài đặt", url: withShop("/app/billing"), keywords: ["billing", "goi", "thanh toan saas"] },
      { id: "developer", title: "API Keys & Webhooks Developer", category: "Cài đặt", url: withShop("/app/developer"), keywords: ["api", "developer", "webhook", "token"] },
      { id: "data", title: "Nhật ký Kiểm toán & Dữ liệu", category: "Cài đặt", url: withShop("/app/data"), keywords: ["audit", "log", "lich su", "xoa"] },
    ];
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
    this.input.addEventListener("input", () => {
      this.filter(this.input?.value.trim() ?? "");
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
        const matchKeywords = item.keywords?.some((k) => k.toLowerCase().includes(q)) ?? false;
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

    if (this.filteredItems.length === 0) {
      this.resultsContainer.innerHTML = `
        <div class="command-empty">
          <p>Không tìm thấy kết quả phù hợp</p>
        </div>
      `;
      return;
    }

    const html = this.filteredItems
      .map((item, index) => {
        const isSelected = index === this.selectedIndex;
        return `
          <a class="command-item ${isSelected ? "is-selected" : ""}" href="${item.url}" data-index="${String(index)}">
            <div class="command-item__body">
              <span class="command-item__title">${item.title}</span>
              <span class="command-item__category">${item.category}</span>
            </div>
            <span class="command-item__enter">↵</span>
          </a>
        `;
      })
      .join("");

    this.resultsContainer.innerHTML = html;

    // Bind item click
    for (const el of this.resultsContainer.querySelectorAll<HTMLAnchorElement>(".command-item")) {
      el.addEventListener("click", () => {
        const idx = Number(el.dataset.index);
        this.selectedIndex = idx;
      });
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
