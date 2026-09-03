import type { StorefrontVertical } from "../storefront/templates";

export type OnboardingProductPreset = {
  currency: string;
  description: string;
  fulfillmentType: "license_key" | "manual";
  icon: string;
  id: string;
  priceMinor: number;
  sku: string;
  slug: string;
  title: string;
  /**
   * Selling vertical the preset belongs to. The onboarding product step only
   * offers presets matching the shop's chosen category so a physical or
   * booking seller never sees digital key samples (and vice versa).
   */
  vertical: StorefrontVertical;
};

export const ONBOARDING_PRODUCT_PRESETS: readonly OnboardingProductPreset[] = [
  {
    currency: "VND",
    description: "Khóa kích hoạt bản quyền Windows 11 Pro Retail vĩnh viễn, nhận key và kích hoạt ngay.",
    fulfillmentType: "license_key",
    icon: "window",
    id: "win11pro",
    priceMinor: 199000,
    sku: "WIN11-PRO-RET",
    slug: "windows-11-pro-retail",
    title: "Windows 11 Pro Retail Bản Quyền",
    vertical: "digital",
  },
  {
    currency: "VND",
    description: "Nâng cấp tài khoản Canva Pro chính chủ thời hạn 1 năm, mở khóa toàn bộ tính năng thiết kế cao cấp.",
    fulfillmentType: "license_key",
    icon: "palette",
    id: "canva-pro",
    priceMinor: 250000,
    sku: "CANVA-PRO-1Y",
    slug: "canva-pro-1-nam",
    title: "Tài khoản Canva Pro 1 Năm",
    vertical: "digital",
  },
  {
    currency: "VND",
    description: "Gói nghe nhạc Spotify Premium 6 Tháng chất lượng cao 320kbps, không quảng cáo, tải offline không giới hạn.",
    fulfillmentType: "license_key",
    icon: "music",
    id: "spotify-premium",
    priceMinor: 150000,
    sku: "SPOTIFY-6M",
    slug: "spotify-premium-6-thang",
    title: "Spotify Premium 6 Tháng",
    vertical: "digital",
  },
  {
    currency: "VND",
    description: "Thẻ Steam Wallet 100.000đ nạp ngay vào tài khoản, phát hành chính hãng, dùng được toàn cầu.",
    fulfillmentType: "license_key",
    icon: "gamepad",
    id: "steam-wallet",
    priceMinor: 89000,
    sku: "STEAM-100K",
    slug: "the-steam-wallet-100k",
    title: "Thẻ Steam Wallet 100.000đ",
    vertical: "digital",
  },
  {
    currency: "VND",
    description: "Bộ tài liệu hướng dẫn xây dựng hệ thống kinh doanh tự động trên Internet từ A-Z (PDF + Video đính kèm).",
    fulfillmentType: "manual",
    icon: "book",
    id: "ebook-course",
    priceMinor: 299000,
    sku: "EBOOK-MMO-2026",
    slug: "ebook-kinh-doanh-tu-dong",
    title: "Ebook: Xây Dựng Hệ Thống Bán Hàng Tự Động",
    vertical: "digital",
  },
  {
    currency: "VND",
    description: "Áo thun cotton 100% form regular unisex, in ấn theo thiết kế riêng, giao toàn quốc cod hoặc chuyển khoản.",
    fulfillmentType: "manual",
    icon: "box",
    id: "tee-local-brand",
    priceMinor: 250000,
    sku: "TEE-LOCAL-001",
    slug: "ao-thun-local-brand",
    title: "Áo Thun Local Brand Unisex",
    vertical: "physical",
  },
  {
    currency: "VND",
    description: "Combo phụ kiện di động cáp sạc nhanh + Ốp lưng chống sốc, bảo hành đổi mới 30 ngày, giao hàng 2-4 ngày.",
    fulfillmentType: "manual",
    icon: "zap",
    id: "mobile-accessory-combo",
    priceMinor: 189000,
    sku: "ACC-COMBO-002",
    slug: "combo-phu-kien-di-dong",
    title: "Combo Phụ Kiện Di Động",
    vertical: "physical",
  },
  {
    currency: "VND",
    description: "Hộp quà tặng thủ công nhân dịp đặc biệt: thiệp, hoa khô và trang trí theo yêu cầu, tặng kèm thiệp viết tay.",
    fulfillmentType: "manual",
    icon: "palette",
    id: "handmade-giftbox",
    priceMinor: 349000,
    sku: "GIFT-HANDMADE-003",
    slug: "hop-qua-tang-handmade",
    title: "Hộp Quà Tặng Handmade",
    vertical: "physical",
  },
  {
    currency: "VND",
    description: "Buổi tư vấn 1-1 kéo dài 60 phút qua video call về chiến lược bán hàng số, đặt lịch theo khung giờ bạn chọn.",
    fulfillmentType: "manual",
    icon: "calendar",
    id: "consulting-session",
    priceMinor: 500000,
    sku: "CONSULT-1ON1-001",
    slug: "tu-van-1-1-60-phut",
    title: "Tư Vấn 1-1 Trực Tuyến (60 phút)",
    vertical: "booking",
  },
  {
    currency: "VND",
    description: "Khóa học trực tuyến 8 buổi kèm tài liệu và bài tập chấm sửa, học qua livestream, xem lại không giới hạn.",
    fulfillmentType: "manual",
    icon: "book",
    id: "online-course",
    priceMinor: 1290000,
    sku: "COURSE-ONLINE-8B",
    slug: "khoa-hoc-truc-tuyen-8-buoi",
    title: "Khóa Học Trực Tuyến 8 Buổi",
    vertical: "booking",
  },
  {
    currency: "VND",
    description: "Dịch vụ thiết kế bộ nhận diện thương hiệu cơ bản (logo + bộ font màu), nhận file gốc và bàn giao trong 5 ngày.",
    fulfillmentType: "manual",
    icon: "palette",
    id: "brand-design-service",
    priceMinor: 2500000,
    sku: "SVC-BRAND-DESIGN",
    slug: "thiet-ke-nhan-dien-thuong-hieu",
    title: "Thiết Kế Bộ Nhận Diện Thương Hiệu",
    vertical: "booking",
  },
] as const;

export function findPresetById(id: string): OnboardingProductPreset | undefined {
  return ONBOARDING_PRODUCT_PRESETS.find((p) => p.id === id);
}

export function getOnboardingPresetById(id: string): OnboardingProductPreset | null {
  return ONBOARDING_PRODUCT_PRESETS.find((p) => p.id === id) ?? null;
}

/** Presets scoped to one selling vertical (onboarding product step filter). */
export function presetsForVertical(vertical: StorefrontVertical): readonly OnboardingProductPreset[] {
  return ONBOARDING_PRODUCT_PRESETS.filter((preset) => preset.vertical === vertical);
}
