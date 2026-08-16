# Landing V4 Design Direction — "Selinow Aurora" (2026-08-16)

Trạng thái: **Approved** — thay thế hướng dẫn thị giác landing v3 cho các surface marketing.
Phạm vi: `/` (landing), `/pricing`, `/solutions`, `/solutions/[slug]`, header/footer marketing.

## 1. Concept

**Dark cinematic + light body.** Trang mở đầu bằng một hero tối "điện ảnh" với nền
generative (aurora gradient mesh + particle network vẽ bằng canvas), typography display
cỡ lớn (44–72px, weight 750), rồi chuyển dần sang body sáng quen thuộc của hệ surface
hiện có, và đóng bằng final CTA tối. Cảm giác đầu tiên phải là "nền tảng đẳng cấp,
được xây nghiêm túc" — theo chuẩn Linear / Vercel / Stripe 2025–2026, không stock photo.

## 2. Scoped override của ràng buộc cũ

`docs/marketing-redesign/CONTEXT_PLAN.md` §4 cấm "purple-on-dark, no glowing borders".
Ràng buộc đó **vẫn giữ nguyên cho mọi surface sáng và cho dashboard/storefront/admin**,
nhưng được ghi đè có kiểm soát CHỈ cho hai surface của marketing:

- `.landing-hero` (và intro band tối của `/pricing`, `/solutions`)
- `.landing-final` (final CTA)

Lý do ghi đè: ấn tượng đầu tiên theo yêu cầu sản phẩm; brand indigo trên nền gần đen
với kiểm soát tương phản WCAG 2.2 AA (text chính ≥ 4.5:1, text lớn ≥ 3:1). Glow chỉ
là ambient backdrop canvas, không phải "glowing border" trang trí trên UI control.

Vẫn cấm tuyệt đối (không đổi): fake metrics, fake testimonials, fake logos,
card-wall syndrome, claim năng lực chưa có (`marketing-surface-contracts`).

## 3. Color & surface

| Role | Token / giá trị | Dùng ở |
| --- | --- | --- |
| Dark canvas | `--dark-canvas: #0A0B12` | hero, final CTA |
| Dark raised | `--dark-raised: rgba(255,255,255,0.04)` | card trên nền tối |
| Dark hairline | `--dark-line: rgba(255,255,255,0.09)` | viền 1px trên nền tối |
| Text trên tối | `#F5F6FA` (primary) / `rgba(233,236,246,0.72)` (secondary) | hero copy |
| Aurora spectrum | `#7C3AED → #6552E8 → #3B82F6` (+ điểm sáng `#9C8BFF`) | canvas, gradient text, accent |
| Brand chính | `--mk-brand: #6552E8` (không đổi) | mọi surface |
| Body sáng | hệ `--surface-*` hiện có | mọi section giữa |

Gradient text chỉ dùng cho **một** cụm từ khoá trong H1; không lạm dụng.

## 4. Typography

- EN: **Inter variable** (400–800) — self-host `public/fonts/inter-var-latin[-ext].woff2`.
- VI: **Be Vietnam Pro** (400/500/600/700, subsets latin + vietnamese) — self-host.
- Stack: `Inter, "Be Vietnam Pro", …` mặc định; `:lang(vi)` đảo thành
  `"Be Vietnam Pro", Inter, …` để tiếng Việt render nhất quán một typeface.
- Display: `clamp(44px, 6.4vw, 72px)`, weight 750, tracking −0.035em, line-height 1.05.
- Section title: giữ `.section-title` hiện có (26–38px, 700).
- Không dùng font weight > 750 cho UI thường; numerals lớn chỉ cho runtime data thật.

## 5. Motion principles (bắt buộc)

1. **IO-driven, play-once**: reveal vào viewport một lần rồi disconnect; stagger
   60–90ms/lẻ, duration 400–700ms, ease `cubic-bezier(0.16, 1, 0.3, 1)`;
   chỉ animate `transform` + `opacity`.
2. **Scroll-linked** dùng thư viện `motion` (`scroll()`, `inView()`): parallax hero
   (copy drift + canvas slow-pan), progress rail của how-it-works. Không scroll-jacking.
3. **Ambient canvas** (hero aurora): rAF loop, DPR ≤ 2, pause khi hero offscreen hoặc
   tab ẩn; `prefers-reduced-motion` → vẽ đúng 1 frame tĩnh rồi dừng.
4. **Demo loop** (lifecycle player trong mock UI): auto-play khi vào viewport,
   giữa các chu kỳ pause 4s, tắt hẳn + hiển thị trạng thái cuối khi reduced-motion.
   Đây là deviation có chủ đích của ràng buộc "không tự động lặp vô hạn": loop
   dừng khi offscreen/hidden và không chặn bất kỳ task nào.
5. **Marquee** kênh: CSS animation chậm, `animation-play-state: paused` khi hover,
   static với reduced-motion.
6. Không bao giờ animate thuộc tính gây layout (width/top/margin); `will-change`
   chỉ đặt trên phần tử đang animate và gỡ sau khi xong.

## 6. Layout & responsiveness

- Container giữ `.platform-shell` (1240px). Hero full-bleed, min-height
  `clamp(560px, 88svh, 860px)`.
- Breakpoints kiểm bắt buộc: 1440, 1024, 768, 390, 320 — không horizontal overflow,
  tap target ≥ 44px, focus ring 2px `--mk-focus` offset 3px.
- Bento grid features: 2 hàng × 3 cột desktop → 2 cột tablet → 1 cột mobile.
- How-it-works: sticky visual trái + bước phải (desktop), stack dọc (mobile ≤ 768px).

## 7. Asset strategy (generative, không stock)

- Toàn bộ visual vẽ bằng code: canvas aurora, SVG kit v4 text-free/locale-neutral
  tại `public/brand/selinow-kit/global/v4/`, mock UI hoạt cảnh bằng HTML/CSS.
- OG cover: SVG master → PNG 1200×630 rasterize bằng script Playwright
  (`scripts/generate-og-image.mjs`), fallback giữ PNG v3 nếu thiếu browser.
- Không thêm file ảnh/video nặng vào `dist/` (giới hạn Workers Assets).

## 8. Conversion architecture

Thứ tự section landing (mỗi section phục vụ một bước funnel):

1. Hero (dark): value prop 1 câu + CTA chính + proof chips + mock UI hoạt cảnh.
2. Channel marquee: coverage thật (Website live, Telegram/WhatsApp/Zalo/Discord next, API planned).
3. Bento features: 6 năng lực thật, icon stroke 1.5–1.8 lucide-style.
4. How it works (sticky story): 4 bước vận hành thật.
5. Architecture board: one core → many experiences, diagram động.
6. Solutions preview: 3 giải pháp thật → `/solutions/*`.
7. Pricing preview: **runtime plans bắt buộc** (`getMarketingPlans`), không hard-code giá.
8. FAQ: chỉ câu hỏi thật có câu trả lời thật.
9. Final CTA (dark): lặp CTA chính + secondary.
10. Footer: dùng lại `MarketingFooter`.

Một CTA chính duy nhất (Start trial → dashboard login), lặp ở hero + pricing + final.
Copy EN/VI song ngữ toàn bộ qua catalog `marketing.home.*` — cấm ternary hardcode.

## 9. Đối chiếu kiểm thử

- `marketing-surface-contracts.test.ts`: mọi assertion phải tiếp tục pass
  (giữ chuỗi contract trong index.astro, pricing runtime hooks, banned claims).
- `marketing-assets-contract.test.ts`: cập nhật sang kit v4, giữ ràng buộc
  channel labels nằm trong HTML + catalog.
- `i18n-call-site-contract` + parity: mọi key mới phải đủ en + vi-VN.
