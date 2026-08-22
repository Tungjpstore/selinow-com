# Kế hoạch redesign Landing + Marketing + Auth — "Editorial Commerce" (chương LP)

Ngày: 2026-08-22 · Trạng thái: **ĐÃ DUYỆT OWNER** (phê duyệt trong phiên làm việc)
Nhánh: `wip/onboarding-redesign-20260820` (giữ nguyên — có session song song; commit LP chỉ add
file của LP bằng đường dẫn tường minh, không bao giờ `git add -A`).

## 0. Quyết định đã chốt

| Quyết định | Lựa chọn |
|---|---|
| Art direction | **Editorial Commerce** — tạp chí thời trang số, nền sáng ivory, typography lớn, ảnh mẫu AI editorial |
| Nguồn ảnh AI | **Nanobanana gateway nội bộ** (OpenAI-compatible `POST /v1/images/generations`, model `nb/nanobanana-pro`, mặc định `http://localhost:20128`) qua script; **ảnh xử lý commit vào repo** — production không phụ thuộc gateway. API key đọc từ env `NANOBANANA_API_KEY`, không bao giờ commit/log. Gateway chuẩn hoá size về 3 tỷ lệ native: 3:2 (1248×832), 2:3 (832×1248), 1:1 (1024²) — pipeline bám đúng 3 tỷ lệ này, chỉ OG crop chuẩn 1200×630 |
| Motion | **WebGL nặng ký**: shader silk/aurora WebGL2 tự viết + Canvas 2D fallback + CSS scroll-driven native — 0 dependency runtime mới |
| Phạm vi | Toàn bộ marketing (`/`, `/pricing`, `/solutions(+slug)`, `/support`, `/legal`, `/privacy`) + auth (`/login`, `/register`, `/forgot-password`) + header/footer |

Giữ lại bộ nhận diện: logo kit `public/brand/logo/`, token indigo `#5B5CEB` / violet `#7C3AED` /
blue `#3B82F6` / teal `#14B8A6`, spine **Selinow Soft `#7C6AF0`**, `core-hub.svg`, router 3-mode
của `index.astro`, pricing runtime từ D1 (`getMarketingPlans`), i18n catalog vi/en.

Loại bỏ: visual CSS-composed cũ (HeroFlowSim markup, CommerceFlowRail), toàn bộ style marketing
legacy (`landing.css` viết lại hoàn toàn, `platform.css` phần marketing sẽ gỡ dần), không dùng lại
asset marketing cũ ngoài brand kit.

## 1. Art direction spec

- **Canvas:** ivory ấm (`--mk-canvas-warm #FAF9F6`) nền chính; mực `#101828`; indigo = action,
  violet gradient = nhấn trang trí, teal = "verified" duy nhất. Không neon AI, không dark homepage.
- **Typography (self-host qua fontsource, cùng origin — không đổi CSP):**
  display **Playfair Display Variable** (H1/H2 editorial), UI **Inter Variable**,
  mono **JetBrains Mono Variable**. `font-display: swap` + fallback metric.
  (Ghi chú: EX plan có non-goal "không web font mới" — LP được owner duyệt hôm nay cho phạm vi
  marketing/auth; CSP `font-src 'self'` giữ nguyên vì font bundle cùng origin.)
- **Ảnh:** editorial thời trang thanh lịch (studio + lifestyle), tông wardrobe tím/indigo/ivory,
  "cùng người mẫu" qua seed cố định + mô tả neo. Nội dung trang trọng phù hợp B2B.
- **Motion (tất cả qua token, `prefers-reduced-motion` tuyệt đối):**
  1. WebGL2 hero backdrop: fragment shader fbm domain-warped → silk/aurora brand-hue;
     ảnh hero reveal bằng clip-path + parallax (CSS `view-timeline` qua `@supports`).
  2. Kinetic type: H1 variable font đổi weight theo scroll.
  3. Scrollytelling Flow: chương sticky 5 bước (kênh → đơn → PayOS verify → giao hàng → khách).
  4. Marquee ticker kênh bán (CSS keyframes, pause khi reduced-motion).
  5. Reveal stagger editorial + count-up (chỉ số thật).

## 2. Bố cục homepage `/`

Giữ: router 3-mode, locale, `getMarketingPlans`, JSON-LD, hreflang, skip-link,
H1/title **"Biến mọi cuộc trò chuyện thành đơn hàng."** (gate assert đúng chuỗi).

1. Header sticky editorial (hairline, ivory, nav, EN/VI, Đăng nhập, CTA "Bắt đầu bán")
2. Hero split 7/5: eyebrow + H1 kinetic + lead + 2 CTA + proof qualitative — phải là ảnh mẫu AI
   trong khung reveal; nền WebGL silk; ticker kênh bên dưới
3. Flow chapter sticky scrollytelling (5 bước)
4. Why — bento lệch 4 ô (ảnh + icon + copy)
5. Commerce Core — diagram ngang, giữ `core-hub.svg` + kênh tiles live/next/planned
6. Solutions — 3 thẻ lớn ảnh nền AI + mini workflow
7. Trust/Payment ownership — ledger 2 cột (giữ tinh thần "không giữ tiền thay seller")
8. Pricing preview — thẻ editorial từ runtime plans (fallback unavailable)
9. FAQ accordion editorial (giữ `.faq-kit-list details` cho gate) + JSON-LD
10. Final CTA full-bleed ảnh + overlay indigo
11. Footer editorial 4 cột

## 3. Kiến trúc kỹ thuật

- **Components:** tách nhánh marketing của `index.astro` thành
  `src/components/marketing/sections/{HeroEditorial,FlowChapter,WhyBento,CommerceCore,SolutionsShowcase,TrustLedger,PricingRuntime,FaqAccordion,FinalCta}.astro`;
  viết lại `MarketingHeader/MarketingFooter`. Section wrapper + `data-reveal` (≥7) giữ ở `index.astro`.
- **CSS:** viết lại `src/styles/marketing/landing.css` (bắt buộc giữ keyframe `mk-flow-step`/`mk-flow-draw`
  theo contract test EX0 — dùng lại cho Flow chapter, non-infinite, token timing) + thêm
  `src/styles/marketing/editorial/{tokens,shell,hero,auth}.css`. Hex Soft chỉ nằm trong token files
  (allowlist của `tests/unit/ex0-experience-contract.test.ts`).
- **Scripts (CSP-safe bundle .ts):**
  - `src/scripts/marketing/hero-canvas.ts` — WebGL2 silk shader + Canvas2D fallback + poster;
    DPR cap 1.5–2; pause offscreen/hidden; **reduced-motion: vẽ 1 frame tĩnh t=0 deterministic**
    (gate chụp với `reducedMotion: "reduce"` + `animations: "disabled"`).
  - `src/scripts/marketing/flow-scene.ts` — scrollytelling (IO + rAF, inert khi reduced-motion).
  - Mở rộng `reveal.ts`; dùng lại `countup.ts`, `navigation.ts`.
- **Pipeline ảnh AI (nanobanana):** `scripts/art/{prompts.mjs,generate-marketing-art.mjs}` + manifest
  `scripts/art/manifest.json`. POST sang gateway nanobanana (env `NANOBANANA_BASE_URL`,
  `NANOBANANA_MODEL`, `NANOBANANA_API_KEY` — key không commit) → raw PNG `art-raw/` (gitignored) →
  **sharp** xuất AVIF/WebP theo các cỡ native vào `public/brand/landing/v1/` (commit). Bộ ~11 render:
  hero desktop/mobile, lifestyle flow ×3, solutions ×3, final-cta, auth panel, og 1200×630
  (crop + composite logo). Validate phản hồi (url/b64) + kích thước; exit non-zero nếu gateway
  không khả dụng; `--only=<id>`/`--force`/`--skip-fetch` để tái tạo chọn lọc.
- **i18n:** giữ key contract hero; thêm key mới vào `src/lib/i18n/catalogs/marketing.ts`
  đủ `en` + `vi-VN` parity.
- **Docs:** plan doc này; cập nhật `docs/frontend-prompt-os/03_DESIGN_SYSTEM/MOTION.md`
  (allowlist motion LP) ở LP4.

## 4. Contract tests phải xanh nguyên vẹn (không sửa test)

- `landing.css`: `@keyframes mk-flow-step`, `@keyframes mk-flow-draw`, không `infinite`,
  có `var(--sln-duration-marketing) var(--sln-ease-standard) both`.
- `index.astro`: ≥ 7 `data-reveal`; `pricing.astro`: `data-reveal-stagger`;
  `login.astro`: `fadeInEnter var(--sln-duration-panel) var(--sln-ease-spring)`;
  `PlatformLayout.astro`: giữ `reveal-boot.ts`.
- `reveal-boot.ts`: giữ `[data-count-to]` + `countUp`.
- Hex Soft (`#7C6AF0 #6957DE #8B7BFF #EBE6F8 #F5F2FB #DAD2EE #C9BDE4 #EDE8FB #6552E8`)
  chỉ được nằm trong token files (allowlist).

## 5. Phases & acceptance

- **LP0 — Foundation & asset pipeline**: plan doc, fontsource + sharp devDeps, prompt library,
  script generate + sinh & commit bộ ảnh, mở rộng marketing tokens. *Acceptance:* manifest đủ,
  ảnh ≤ ~250KB/variants, `npm run check` pass.
- **LP1 — Homepage `/`**: sections mới + header/footer + CSS editorial + WebGL hero + i18n.
  *Acceptance:* đủ 11 khối; reduced-motion tắt sạch animation; không console error; không
  overflow 320/390px; axe AA; H1/title đúng chuỗi gate.
- **LP2 — `/pricing` + `/solutions`(+slug, support gate, legal/privacy)**: cùng ngôn ngữ editorial.
  *Acceptance:* pass bộ check như LP1; `PublicationGate` giữ hành vi "not approved".
- **LP3 — Auth trio**: split editorial (panel ảnh + form), **giữ 100% flow/state/bundle TS**
  (magic-link, 2FA inline, Turnstile, register 2 bước, forgot 3 bước), migrate `auth-soft.css`
  lên spine. *Acceptance:* auth browser gate pass (cập nhật selector/baseline nếu cần).
- **LP4 — Motion polish + perf**: MOTION.md, reduced-motion rà toàn diện, LCP hero
  (fetchpriority + `<picture>` AVIF/WebP + width/height), `content-visibility` below-fold,
  og image mới.
- **LP5 — Gates, QA, docs**: recapture baseline screenshots (1440/390/720 mọi trang),
  chạy đủ `check`/`lint`/`test`/`build`/`deploy:dry-run` + browser gates public & auth,
  cập nhật `IMPLEMENTATION_STATUS.md` + `COLOR_AND_SURFACES.md` + screen spec LANDING_PAGE.md.

Mỗi phase commit riêng (`LP0:`…`LP5:`, message tiếng Anh, chỉ add file của LP).

## 6. Rủi ro & cách xử

- **Session song song cùng nhánh** (PlatformLayout, playwright config, gate script, docs đang
  dirty): sửa file dùng chung bằng edit nhỏ; khi commit file đang dirty dùng staging surgical
  (`git apply --cached` patch của riêng hunks LP) thay vì `git add` cả file.
- **Gate chặn request ngoại + locale vi-VN cưỡng bức:** asset local 100%; copy vi-VN trước.
- **WebGL perf mobile:** cap DPR, pause offscreen, fallback poster; frame t=0 deterministic.
- **Endpoint ảnh miễn phí không ổn định:** seed + retry + validate; ảnh commit nên production
  an toàn; tái tạo chỉ khi chủ đích (`npm run art:generate -- --only=<id>`).
- **Trùng phạm vi EX (đang chờ duyệt):** LP là quyết định owner cho vùng marketing/auth;
  khi duyệt EX cần ghi nhận LP thay phần marketing/auth của EX.

## 7. Verification cuối (theo AGENTS.md)

`npm run check` && `npm run lint` && `npm run test` && `npm run build` && `npm run deploy:dry-run`
+ browser gates public & auth local — tất cả xanh mới báo hoàn thành.
