# Global SEO Strategy

## Mục tiêu

Đưa `selinow.com` trở thành landing/product site có thể được khám phá trên thị trường quốc tế, trong khi storefront của từng shop vẫn giữ canonical theo hostname và tenant. SEO không được thay đổi authority của D1, checkout, payment, inventory hoặc fulfillment.

## Hiện trạng và quyết định

- Nền tảng hiện có hai locale được dịch đầy đủ: `en` và `vi-VN`. Đây là nền tảng global, chưa phải cam kết hỗ trợ mọi ngôn ngữ.
- Locale có URL ổn định bằng `?lang=vi-VN`; URL tiếng Anh mặc định không thêm query. HTML phát `hreflang` cho `en`, `vi-VN` và `x-default`, `Content-Language`, `og:locale` và canonical theo biến thể được yêu cầu.
- Marketing (`/`, `/pricing`) là public SEO. Login, app, admin, onboarding, cart, checkout, order và API đều noindex/no-store.
- `robots.txt` và `sitemap.xml` chạy theo hostname. Marketing sitemap chỉ chứa các trang platform; storefront sitemap chỉ chứa home và product URLs của shop live. Local/staging luôn `Disallow: /`.
- JSON-LD hiện có SoftwareApplication + FAQPage cho marketing, WebPage + BreadcrumbList cho pricing, OnlineStore + OfferCatalog cho storefront home và Product + Offer cho product detail.
- Không dùng `meta keywords`; Google/Bing không coi đây là tín hiệu xếp hạng hữu ích.

## Ưu tiên triển khai

### P0 — Technical foundation (đã triển khai)

1. Canonical, `hreflang`, Open Graph locale, Twitter image metadata.
2. Robots/sitemap theo platform và tenant; loại bỏ URL giao dịch khỏi crawl.
3. Product/Organization-like structured data chỉ từ dữ liệu public đã publish.
4. Language switcher để bot và người dùng đều khám phá được phiên bản tiếng Anh.

### P1 — Nội dung có ý định tìm kiếm (cần làm)

- Tạo các trang tiếng Anh có intent rõ ràng: `Telegram store`, `digital product delivery`, `license key inventory`, `PayOS commerce`, `multi-channel commerce automation`.
- Mỗi trang cần một intent chính, title dưới khoảng 60 ký tự, meta description khoảng 140–160 ký tự, một `h1`, bằng chứng sản phẩm, FAQ và CTA.
- Viết use-case theo ngành (creator, paid community, software/license seller, digital download) nhưng không hứa tính năng/provider chưa được kích hoạt.
- Bổ sung tài liệu hữu ích (setup, payment verification, fulfillment safety, migration checklist) bằng English trước; dịch Vietnamese sau khi bản English ổn định.

### P2 — Authority và phân phối (cần làm)

- Kết nối Google Search Console và Bing Webmaster cho `selinow.com` và các custom domains đã được seller xác minh.
- Submit sitemap, theo dõi index coverage, canonical/hreflang errors, Core Web Vitals và rich-result enhancements.
- Xây backlink có liên quan: Telegram commerce, creator tools, digital delivery, developer integrations; tránh paid link hoặc directory spam.
- Thu thập first-party analytics không chứa credential, payment payload, order token hay license plaintext; đo organic landing, signup và publish-ready event.

## Quy tắc global

- Chỉ thêm locale khi có bản dịch người biên tập kiểm duyệt; không tạo hàng loạt trang dịch máy mỏng.
- Không tự sinh country pages nếu không có offer, pricing, legal/support và nội dung phù hợp thị trường đó.
- Giữ URL locale nhất quán và reciprocal: mỗi biến thể phải trỏ canonical chính nó và liên kết lại các `hreflang` khác.
- Storefront content do seller nhập hiện single-language; không gắn nhãn hreflang như thể catalog đã được dịch hoàn chỉnh.
- Không đưa cart, checkout, order token, payment status hoặc private fulfillment URL vào sitemap.

## Đo lường và ngưỡng ra quyết định

- Sau khi deploy production: kiểm tra HTTP 200, canonical, `hreflang`, robots, sitemap, JSON-LD và noindex trên platform + một tenant live.
- Sau 2–4 tuần: xem impressions/clicks theo query và locale; chỉ mở rộng content cluster có CTR/engagement tốt.
- Sau 6–8 tuần: ưu tiên các trang có impressions nhưng CTR thấp (title/description), rồi các trang có CTR tốt nhưng signup thấp (message/CTA/product proof).
- SEO không được coi là hoàn tất chỉ vì sitemap tồn tại; cần Search Console coverage và chuyển đổi organic có dữ liệu.

## External requirements

- Production DNS/SSL cho `selinow.com` và custom domains phải active; staging/local không được index.
- Cần owner cho editorial English, translation review, privacy/cookie consent, analytics retention và Search Console.
- Cần xác nhận claim/provider/legal copy trước khi publish landing pages theo quốc gia hoặc theo payment provider.

## Intent pages and machine-readable discovery (2026-08-02)

- Added the bilingual `/solutions` hub and three intent-specific pages: `/solutions/telegram-commerce`, `/solutions/digital-product-delivery`, and `/solutions/license-key-inventory`.
- Each solution page has one primary `h1`, a concise answer block, workflow proof, FAQPage JSON-LD, BreadcrumbList JSON-LD, canonical metadata and reciprocal `hreflang` variants.
- Added the solution hub and detail URLs to the production marketing sitemap. No private, transactional, or unverified provider surfaces were added.
- Added production-only `/llms.txt` with factual product boundaries and official canonical links. Local and staging requests return `404` with `noindex` to prevent accidental discovery.
- Internal solution navigation preserves the selected `en`/`vi-VN` variant; all user-facing copy is stored in typed content data rather than duplicated in templates.
- Remaining external work is unchanged: deploy the source, resubmit the sitemap in Search Console, validate rich results, and measure query-level performance before expanding the content cluster.
