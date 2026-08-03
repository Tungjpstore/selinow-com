import type { SupportedLocale } from "../i18n/locale";

export type SolutionSlug = "telegram-commerce" | "digital-product-delivery" | "license-key-inventory";

export type SolutionFaq = Readonly<{
  question: string;
  answer: string;
}>;

export type SolutionStep = Readonly<{
  title: string;
  description: string;
}>;

export type SolutionContent = Readonly<{
  slug: SolutionSlug;
  seoTitle: string;
  seoDescription: string;
  eyebrow: string;
  title: string;
  lead: string;
  answerLabel: string;
  answer: string;
  proofLabel: string;
  proof: readonly string[];
  workflowLabel: string;
  workflowTitle: string;
  workflow: readonly SolutionStep[];
  faqLabel: string;
  faqTitle: string;
  faq: readonly SolutionFaq[];
  cta: string;
  ctaSecondary: string;
  relatedLabel: string;
}>;

export type SolutionsHubContent = Readonly<{
  seoTitle: string;
  seoDescription: string;
  eyebrow: string;
  title: string;
  lead: string;
  answerLabel: string;
  answer: string;
  cardLabel: string;
  cardTitle: string;
  cardDescription: string;
  solutionsLabel: string;
  proofTitle: string;
  relatedTitle: string;
  relatedHomeLabel: string;
  relatedHomeTitle: string;
  homeCoreCta: string;
  cta: string;
  ctaSecondary: string;
  footerTagline: string;
}>;

export type SolutionNotFoundContent = Readonly<{
  title: string;
  description: string;
}>;

type LocalizedSolution = Omit<SolutionContent, "slug">;

const solutions: Readonly<Record<SolutionSlug, Readonly<Record<SupportedLocale, LocalizedSolution>>>> = {
  "telegram-commerce": {
    en: {
      seoTitle: "Telegram commerce platform for digital sellers | Selinow",
      seoDescription: "Run a Telegram-first digital store with one catalog, verified payment states, safe fulfillment, and a bilingual storefront.",
      eyebrow: "TELEGRAM COMMERCE",
      title: "Turn Telegram conversations into a storefront that can scale.",
      lead: "Give customers a familiar buying path inside Telegram while your team runs products, orders, payment checks, and fulfillment from one clear operating layer.",
      answerLabel: "The short answer",
      answer: "Selinow is a Telegram-first commerce platform for digital products. It keeps the Telegram buying experience connected to the same catalog, order, payment, and fulfillment services used by the Website storefront.",
      proofLabel: "Built for serious operations",
      proof: [
        "Website and Telegram share one order lifecycle",
        "Payment and fulfillment stay separate until verified",
        "English and Vietnamese storefront experiences",
        "Tenant-isolated catalog and audit history",
      ],
      workflowLabel: "How it works",
      workflowTitle: "A shorter path from message to delivered product.",
      workflow: [
        { title: "Connect the channel", description: "Bring your Telegram bot into the store setup and check the connection before publishing." },
        { title: "Publish the catalog", description: "Use the same products, variants, prices, and inventory rules across Telegram and the Website." },
        { title: "Verify the order", description: "Keep server-confirmed price, stock, payment, and fulfillment states visible to the team." },
        { title: "Deliver with confidence", description: "Release digital files or license access only after the payment boundary is satisfied." },
      ],
      faqLabel: "Telegram commerce FAQ",
      faqTitle: "What teams ask before launching.",
      faq: [
        { question: "Is Selinow only for Telegram?", answer: "No. Website and Telegram are the current launch channels; future providers remain separately gated until accepted." },
        { question: "Does a Telegram payment automatically release a product?", answer: "No. Selinow keeps payment confirmation and fulfillment as separate states and only releases eligible delivery after verification." },
        { question: "Can the store be bilingual?", answer: "Yes. The platform marketing and storefront shell support English and Vietnamese locale variants with reciprocal metadata." },
      ],
      cta: "Start a Telegram store",
      ctaSecondary: "Compare plans",
      relatedLabel: "Continue exploring",
    },
    "vi-VN": {
      seoTitle: "Nền tảng Telegram cho người bán sản phẩm số | Selinow",
      seoDescription: "Vận hành cửa hàng sản phẩm số trên Telegram với catalog thống nhất, thanh toán được xác minh, giao hàng an toàn và storefront song ngữ.",
      eyebrow: "THƯƠNG MẠI TELEGRAM",
      title: "Biến cuộc trò chuyện trên Telegram thành cửa hàng có thể mở rộng.",
      lead: "Đưa khách hàng vào luồng mua quen thuộc trong Telegram, đồng thời vận hành sản phẩm, đơn hàng, kiểm tra thanh toán và giao hàng trên một lớp điều hành rõ ràng.",
      answerLabel: "Câu trả lời ngắn",
      answer: "Selinow là nền tảng thương mại ưu tiên Telegram cho sản phẩm số. Trải nghiệm mua trong Telegram dùng chung catalog, đơn hàng, thanh toán và giao hàng với storefront Website.",
      proofLabel: "Thiết kế cho vận hành nghiêm túc",
      proof: [
        "Website và Telegram dùng chung vòng đời đơn hàng",
        "Thanh toán và giao hàng tách biệt cho đến khi xác minh",
        "Trải nghiệm storefront English và Tiếng Việt",
        "Catalog và lịch sử audit được cô lập theo tenant",
      ],
      workflowLabel: "Cách hoạt động",
      workflowTitle: "Rút ngắn đường đi từ tin nhắn đến sản phẩm đã giao.",
      workflow: [
        { title: "Kết nối kênh", description: "Đưa bot Telegram vào thiết lập cửa hàng và kiểm tra kết nối trước khi publish." },
        { title: "Publish catalog", description: "Dùng chung sản phẩm, biến thể, giá và quy tắc inventory trên Telegram và Website." },
        { title: "Xác minh đơn hàng", description: "Giữ giá, tồn kho, thanh toán và trạng thái giao hàng đã xác nhận trên server." },
        { title: "Giao hàng an tâm", description: "Chỉ mở file số hoặc quyền truy cập license sau khi điều kiện thanh toán được xác minh." },
      ],
      faqLabel: "Câu hỏi về thương mại Telegram",
      faqTitle: "Điều đội ngũ thường hỏi trước khi launch.",
      faq: [
        { question: "Selinow chỉ dành cho Telegram?", answer: "Không. Website và Telegram là hai kênh launch hiện tại; provider tương lai được tách riêng cho đến khi được chấp nhận." },
        { question: "Thanh toán trên Telegram có tự động giao sản phẩm không?", answer: "Không. Selinow tách xác nhận thanh toán khỏi giao hàng và chỉ giao nội dung đủ điều kiện sau khi xác minh." },
        { question: "Cửa hàng có thể song ngữ không?", answer: "Có. Marketing và storefront shell hỗ trợ English và Tiếng Việt cùng metadata liên kết hai chiều." },
      ],
      cta: "Bắt đầu cửa hàng Telegram",
      ctaSecondary: "So sánh bảng giá",
      relatedLabel: "Khám phá tiếp",
    },
  },
  "digital-product-delivery": {
    en: {
      seoTitle: "Digital product delivery automation | Selinow",
      seoDescription: "Automate digital file and access delivery after verified checkout, with clear order states, private grants, and safe retry boundaries.",
      eyebrow: "DIGITAL PRODUCT DELIVERY",
      title: "Deliver digital products without turning fulfillment into guesswork.",
      lead: "Keep checkout, payment verification, entitlement, and delivery visible as separate states so a customer gets access only when the order is actually ready.",
      answerLabel: "The short answer",
      answer: "Selinow automates the operational path after a digital order: capture the product requirement, verify the payment boundary, allocate the eligible delivery, and preserve a durable history for the seller.",
      proofLabel: "Designed for delivery safety",
      proof: [
        "Private file and access requirements are captured at checkout",
        "Paid delivery waits for exact payment evidence",
        "Free and paid orders use bounded, replay-safe flows",
        "Delivery history stays inspectable without exposing secrets",
      ],
      workflowLabel: "Delivery workflow",
      workflowTitle: "From product requirement to a controlled handoff.",
      workflow: [
        { title: "Define the offer", description: "Attach a delivery policy to the product and keep the requirement bound to the order item." },
        { title: "Confirm the boundary", description: "Separate checkout completion from payment confirmation so redirects never mark an order paid." },
        { title: "Allocate access", description: "Create the eligible private grant or digital allocation with tenant and order checks." },
        { title: "Keep the record", description: "Retain safe lifecycle evidence, retry states, and expiry checks without logging plaintext secrets." },
      ],
      faqLabel: "Digital delivery FAQ",
      faqTitle: "Clear answers for a sensitive workflow.",
      faq: [
        { question: "Can a return URL release a digital product?", answer: "No. Delivery requires the authoritative payment boundary, not a browser redirect or QR render." },
        { question: "What can Selinow deliver?", answer: "The current product boundary supports digital files, private downloads, and license-related fulfillment paths that pass the configured checks." },
        { question: "What happens when a provider response is ambiguous?", answer: "The operation remains pending or enters reconciliation instead of auto-fulfilling an uncertain payment or delivery." },
      ],
      cta: "Build a digital store",
      ctaSecondary: "See the workflow",
      relatedLabel: "Related operating guides",
    },
    "vi-VN": {
      seoTitle: "Tự động giao sản phẩm số sau checkout | Selinow",
      seoDescription: "Tự động hóa giao file và quyền truy cập sau checkout được xác minh với trạng thái rõ ràng, private grant và retry an toàn.",
      eyebrow: "GIAO SẢN PHẨM SỐ",
      title: "Giao sản phẩm số mà không biến fulfillment thành phỏng đoán.",
      lead: "Giữ checkout, xác minh thanh toán, entitlement và giao hàng thành các trạng thái riêng để khách chỉ nhận quyền truy cập khi đơn hàng thực sự sẵn sàng.",
      answerLabel: "Câu trả lời ngắn",
      answer: "Selinow tự động hóa đường đi sau một đơn hàng số: ghi nhận yêu cầu sản phẩm, xác minh ranh giới thanh toán, cấp delivery đủ điều kiện và lưu lịch sử bền vững cho người bán.",
      proofLabel: "Thiết kế cho giao hàng an toàn",
      proof: [
        "Yêu cầu file riêng và quyền truy cập được snapshot lúc checkout",
        "Đơn trả phí chỉ giao sau khi có bằng chứng thanh toán chính xác",
        "Luồng free và paid có replay boundary rõ ràng",
        "Lịch sử giao hàng kiểm tra được mà không lộ secret",
      ],
      workflowLabel: "Luồng giao hàng",
      workflowTitle: "Từ yêu cầu sản phẩm đến bàn giao có kiểm soát.",
      workflow: [
        { title: "Định nghĩa offer", description: "Gắn policy giao hàng vào sản phẩm và giữ requirement với order item." },
        { title: "Xác nhận ranh giới", description: "Tách checkout hoàn tất khỏi xác nhận thanh toán; redirect không được đánh dấu paid." },
        { title: "Cấp quyền truy cập", description: "Tạo private grant hoặc digital allocation đủ điều kiện với kiểm tra tenant và order." },
        { title: "Giữ bằng chứng", description: "Lưu lifecycle, retry và expiry an toàn mà không ghi plaintext secret." },
      ],
      faqLabel: "Câu hỏi về giao sản phẩm số",
      faqTitle: "Câu trả lời rõ cho luồng nhạy cảm.",
      faq: [
        { question: "Return URL có thể tự giao sản phẩm số không?", answer: "Không. Giao hàng cần ranh giới thanh toán authoritative, không dựa vào redirect hoặc QR." },
        { question: "Selinow có thể giao gì?", answer: "Phạm vi hiện tại hỗ trợ file số, private download và các luồng fulfillment liên quan license khi qua đủ kiểm tra." },
        { question: "Nếu provider trả về trạng thái mơ hồ thì sao?", answer: "Operation giữ pending hoặc vào reconciliation thay vì tự động fulfill một thanh toán hay delivery chưa chắc chắn." },
      ],
      cta: "Xây cửa hàng sản phẩm số",
      ctaSecondary: "Xem luồng hoạt động",
      relatedLabel: "Hướng dẫn liên quan",
    },
  },
  "license-key-inventory": {
    en: {
      seoTitle: "License key inventory management | Selinow",
      seoDescription: "Manage digital license key inventory with encrypted storage, allocation guards, safe fulfillment, and a seller-visible audit trail.",
      eyebrow: "LICENSE KEY INVENTORY",
      title: "Treat license keys like inventory, not like text in a spreadsheet.",
      lead: "Protect key material, prevent cross-store allocation, and connect inventory availability to a verified order lifecycle your team can inspect.",
      answerLabel: "The short answer",
      answer: "Selinow gives digital sellers a controlled license-key inventory path: keys remain protected in storage, allocations are tenant-scoped, and fulfillment only proceeds through an eligible order state.",
      proofLabel: "Control where it matters",
      proof: [
        "Tenant-leading inventory boundaries",
        "Encrypted key storage with versioned key management",
        "One-winner allocation and concurrency protection",
        "Exports and logs exclude license plaintext",
      ],
      workflowLabel: "Inventory workflow",
      workflowTitle: "A safer path from stock count to customer access.",
      workflow: [
        { title: "Import or create stock", description: "Bring keys into the store boundary without making plaintext inventory part of normal logs or exports." },
        { title: "Check availability", description: "Use authoritative inventory state for quotes, reservations, and allocation decisions." },
        { title: "Allocate once", description: "Concurrency guards prevent two buyers or two retries from receiving the same key." },
        { title: "Reveal at the edge", description: "Decrypt only in the authorized fulfillment boundary and enforce order access and expiry checks." },
      ],
      faqLabel: "License inventory FAQ",
      faqTitle: "The safety questions worth answering early.",
      faq: [
        { question: "Are license keys stored as plaintext?", answer: "No. The product boundary keeps key material encrypted and excludes plaintext from normal audit, queue, export, and log payloads." },
        { question: "Can two retries consume one key?", answer: "Allocation and replay boundaries are designed to produce one durable winner while preserving a safe retry result." },
        { question: "Can a shop access another shop's inventory?", answer: "No. Shop-owned queries and mutations preserve tenant isolation, including inventory and fulfillment paths." },
      ],
      cta: "Protect your key inventory",
      ctaSecondary: "Explore digital delivery",
      relatedLabel: "Related operating guides",
    },
    "vi-VN": {
      seoTitle: "Quản lý inventory license key an toàn | Selinow",
      seoDescription: "Quản lý inventory license key với lưu trữ mã hóa, guard cấp phát, fulfillment an toàn và audit trail cho seller.",
      eyebrow: "INVENTORY LICENSE KEY",
      title: "Coi license key là inventory, không phải text trong spreadsheet.",
      lead: "Bảo vệ key material, ngăn cấp phát chéo shop và gắn tồn kho với vòng đời đơn hàng đã xác minh để đội ngũ luôn kiểm tra được.",
      answerLabel: "Câu trả lời ngắn",
      answer: "Selinow cung cấp luồng inventory license key có kiểm soát: key được bảo vệ khi lưu trữ, allocation giới hạn theo tenant và fulfillment chỉ chạy khi order đủ điều kiện.",
      proofLabel: "Kiểm soát đúng điểm quan trọng",
      proof: [
        "Ranh giới inventory dẫn đầu bởi tenant",
        "Lưu key mã hóa với key management có version",
        "Guard cấp phát một người thắng và chống concurrency",
        "Export và log không chứa plaintext license",
      ],
      workflowLabel: "Luồng inventory",
      workflowTitle: "Đường đi an toàn hơn từ số lượng tồn đến quyền truy cập.",
      workflow: [
        { title: "Import hoặc tạo stock", description: "Đưa key vào ranh giới shop mà không đưa plaintext inventory vào log hoặc export thông thường." },
        { title: "Kiểm tra sẵn có", description: "Dùng inventory authoritative cho quote, reservation và quyết định cấp phát." },
        { title: "Cấp phát một lần", description: "Concurrency guard ngăn hai buyer hoặc hai retry nhận cùng một key." },
        { title: "Reveal tại edge", description: "Chỉ decrypt trong fulfillment boundary được phép và kiểm tra order access cùng expiry." },
      ],
      faqLabel: "Câu hỏi về inventory license",
      faqTitle: "Những câu hỏi an toàn cần trả lời sớm.",
      faq: [
        { question: "License key có được lưu plaintext không?", answer: "Không. Key material được mã hóa và plaintext không xuất hiện trong audit, queue, export hay log thông thường." },
        { question: "Hai retry có thể ăn cùng một key không?", answer: "Allocation và replay boundary được thiết kế để chỉ có một winner bền vững, còn retry nhận kết quả an toàn." },
        { question: "Shop này có thể đọc inventory shop khác không?", answer: "Không. Mọi query và mutation theo shop đều giữ tenant isolation, gồm cả inventory và fulfillment." },
      ],
      cta: "Bảo vệ inventory license key",
      ctaSecondary: "Khám phá giao sản phẩm số",
      relatedLabel: "Hướng dẫn liên quan",
    },
  },
};

const hub: Readonly<Record<SupportedLocale, SolutionsHubContent>> = {
  en: {
    seoTitle: "Commerce solutions for digital sellers | Selinow",
    seoDescription: "Explore practical Selinow solutions for Telegram commerce, digital product delivery, and protected license-key inventory.",
    eyebrow: "SELINOW SOLUTIONS",
    title: "The operating layer behind a focused digital store.",
    lead: "Start with the workflow that matters most today across Website and Telegram without splitting your catalog, payment evidence, or fulfillment history.",
    answerLabel: "Where to start",
    answer: "Selinow gives digital sellers one bilingual commerce core for Website, Telegram, verified checkout, and controlled delivery.",
    cardLabel: "Choose a workflow",
    cardTitle: "Solve the operational bottleneck first.",
    cardDescription: "Each guide explains the product boundary, the safer state transitions, and the questions teams should answer before launch.",
    solutionsLabel: "Solutions",
    proofTitle: "The operating layer stays visible.",
    relatedTitle: "Build the next layer when you are ready.",
    relatedHomeLabel: "SELINOW OS",
    relatedHomeTitle: "See the full commerce core.",
    homeCoreCta: "See the commerce core",
    cta: "Start building your store",
    ctaSecondary: "Compare plans",
    footerTagline: "Focused commerce operations for digital products.",
  },
  "vi-VN": {
    seoTitle: "Giải pháp thương mại cho người bán sản phẩm số | Selinow",
    seoDescription: "Khám phá các giải pháp Selinow cho thương mại Telegram, giao sản phẩm số và inventory license key được bảo vệ.",
    eyebrow: "GIẢI PHÁP SELINOW",
    title: "Lớp điều hành phía sau một cửa hàng sản phẩm số tập trung.",
    lead: "Bắt đầu từ luồng quan trọng nhất hôm nay trên Website và Telegram mà không tách catalog, bằng chứng thanh toán hay lịch sử fulfillment.",
    answerLabel: "Nên bắt đầu từ đâu",
    answer: "Selinow cung cấp commerce core song ngữ cho Website, Telegram, checkout được xác minh và giao hàng có kiểm soát.",
    cardLabel: "Chọn một luồng",
    cardTitle: "Giải quyết điểm nghẽn vận hành trước.",
    cardDescription: "Mỗi hướng dẫn giải thích ranh giới sản phẩm, các trạng thái an toàn hơn và câu hỏi cần trả lời trước khi launch.",
    solutionsLabel: "Giải pháp",
    proofTitle: "Lớp điều hành luôn rõ ràng.",
    relatedTitle: "Xây lớp tiếp theo khi bạn sẵn sàng.",
    relatedHomeLabel: "SELINOW OS",
    relatedHomeTitle: "Xem commerce core hoàn chỉnh.",
    homeCoreCta: "Xem commerce core",
    cta: "Bắt đầu xây cửa hàng",
    ctaSecondary: "So sánh bảng giá",
    footerTagline: "Vận hành thương mại tập trung cho sản phẩm số.",
  },
};

const notFound: Readonly<Record<SupportedLocale, SolutionNotFoundContent>> = {
  en: { title: "Not found", description: "The requested solution is not available." },
  "vi-VN": { title: "Không tìm thấy", description: "Giải pháp bạn yêu cầu không khả dụng." },
};

export const solutionSlugs = Object.keys(solutions) as SolutionSlug[];

export function getSolutionPage(slug: string, locale: SupportedLocale): SolutionContent | null {
  if (!(solutionSlugs as readonly string[]).includes(slug)) return null;
  const solution = solutions[slug as SolutionSlug];
  return { ...solution[locale], slug: slug as SolutionSlug };
}

export function getSolutionsHub(locale: SupportedLocale): SolutionsHubContent {
  return hub[locale];
}

export function getSolutionNotFound(locale: SupportedLocale): SolutionNotFoundContent {
  return notFound[locale];
}
