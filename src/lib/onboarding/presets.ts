export type OnboardingProductPreset = {
  currency: string;
  description: string;
  fulfillmentType: "license_key" | "manual";
  icon: string;
  id: string;
  priceMinor: number;
  sampleKeys: string[];
  sku: string;
  slug: string;
  title: string;
};

export const ONBOARDING_PRODUCT_PRESETS: readonly OnboardingProductPreset[] = [
  {
    currency: "VND",
    description: "Khóa kích hoạt bản quyền Windows 11 Pro Retail vĩnh viễn, nhận key và kích hoạt ngay.",
    fulfillmentType: "license_key",
    icon: "🪟",
    id: "win11pro",
    priceMinor: 199000,
    sampleKeys: [
      "W269N-WFGWX-YVC9B-4J6C9-T83GX",
      "VK7JG-NPHTM-C97JM-9MPGT-3V66T",
      "MH37W-N47XK-V7XM9-C7227-GCQG9",
      "NRG8B-VKK3Q-CXVCJ-9G2XF-6Q84J",
      "DPH2V-TTNVB-4X9Q3-TJR4H-KHJW4",
    ],
    sku: "WIN11-PRO-RET",
    slug: "windows-11-pro-retail",
    title: "Windows 11 Pro Retail Bản Quyền",
  },
  {
    currency: "VND",
    description: "Nâng cấp tài khoản Canva Pro chính chủ thời hạn 1 năm, mở khóa toàn bộ tính năng thiết kế cao cấp.",
    fulfillmentType: "license_key",
    icon: "🎨",
    id: "canva-pro",
    priceMinor: 250000,
    sampleKeys: [
      "CANVA-PRO-1Y-INVITE-882193",
      "CANVA-PRO-1Y-INVITE-773104",
      "CANVA-PRO-1Y-INVITE-664912",
      "CANVA-PRO-1Y-INVITE-551029",
      "CANVA-PRO-1Y-INVITE-449811",
    ],
    sku: "CANVA-PRO-1Y",
    slug: "canva-pro-1-nam",
    title: "Tài khoản Canva Pro 1 Năm",
  },
  {
    currency: "VND",
    description: "Gói nghe nhạc Spotify Premium 6 Tháng chất lượng cao 320kbps, không quảng cáo, tải offline không giới hạn.",
    fulfillmentType: "license_key",
    icon: "🎵",
    id: "spotify-premium",
    priceMinor: 150000,
    sampleKeys: [
      "SPOTIFY-6M-CODE-99482-VN",
      "SPOTIFY-6M-CODE-88371-VN",
      "SPOTIFY-6M-CODE-77260-VN",
      "SPOTIFY-6M-CODE-66159-VN",
      "SPOTIFY-6M-CODE-55048-VN",
    ],
    sku: "SPOTIFY-6M",
    slug: "spotify-premium-6-thang",
    title: "Gói Spotify Premium 6 Tháng",
  },
  {
    currency: "VND",
    description: "Thẻ nạp ví Steam Wallet mệnh giá 100.000đ nạp trực tiếp vào tài khoản Steam mua game bản quyền.",
    fulfillmentType: "license_key",
    icon: "🎮",
    id: "steam-wallet",
    priceMinor: 100000,
    sampleKeys: [
      "STEAM-VN-100K-38A91-88DC",
      "STEAM-VN-100K-49B02-99ED",
      "STEAM-VN-100K-50C13-00FE",
      "STEAM-VN-100K-61D24-11GF",
      "STEAM-VN-100K-72E35-22HG",
    ],
    sku: "STEAM-100K",
    slug: "the-steam-wallet-100k",
    title: "Thẻ Steam Wallet 100.000đ",
  },
  {
    currency: "VND",
    description: "Bộ tài liệu hướng dẫn xây dựng hệ thống kinh doanh tự động trên Internet từ A-Z (PDF + Video đính kèm).",
    fulfillmentType: "manual",
    icon: "📚",
    id: "ebook-course",
    priceMinor: 299000,
    sampleKeys: [],
    sku: "EBOOK-MMO-2026",
    slug: "ebook-kinh-doanh-tu-dong",
    title: "Ebook: Xây Dựng Hệ Thống Bán Hàng Tự Động",
  },
] as const;

export function findPresetById(id: string): OnboardingProductPreset | undefined {
  return ONBOARDING_PRODUCT_PRESETS.find((p) => p.id === id);
}

export function getOnboardingPresetById(id: string): OnboardingProductPreset | null {
  return ONBOARDING_PRODUCT_PRESETS.find((p) => p.id === id) ?? null;
}
