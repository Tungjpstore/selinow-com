# Yeu cau design va interaction

## Muc tieu

Frontend moi duoc phep co mot ngon ngu thiet ke hoan toan khac bo hien tai. Muc tieu khong phai sao chep PromptOS ma la tao mot he thong co chu dich, nhanh, ro trang thai va lam noi bat cong viec seller/buyer. Business contract phai giu nguyen.

## Nguyen tac trai nghiem

- Uu tien "viec can lam tiep theo" va risk/health hon vanity dashboard metric.
- Moi con so phai co data authority; khong tao fake revenue, conversion, stock, quota hay provider uptime.
- Payment va fulfillment luon hien hai status rieng tren list va detail.
- Waiting-user, waiting-provider va retryable la ba trang thai khac nhau, co copy va CTA khac nhau.
- Read-only surface phai noi ro la read-only; khong render button disabled cho mutation chua ton tai neu no gay ky vong sai.
- Destructive/risk action can consequence copy, explicit confirmation, pending lock va result reference.
- Safe request ID duoc hien trong error diagnostics; khong hien raw stack/provider payload.

## Responsive

- Primary mobile: 390 px; minimum supported: 320 px.
- Test bat buoc: 1440x1024, 768x1024, 390x844, 320x568 va zoom 200%.
- Khong horizontal overflow. Table phai chuyen thanh cards/definition-list hoac scroll region co label; khong ep toan page scroll ngang.
- Sticky action khong che focus target, toast, keyboard hoac browser chrome.
- Tap target toi thieu 44x44 CSS px; khoang cach giua destructive va primary action du de tranh bam nham.

## Accessibility

- WCAG 2.2 AA.
- Mot `h1` ro rang, landmark dung nghia, label va description lien ket.
- Tat ca flow dung duoc bang keyboard; focus visible; dialog/drawer trap va restore focus dung.
- `aria-live` chi cho thay doi can doc; khong doc lap lai toan bang.
- Status khong chi dua vao mau; co text/icon semantic.
- Respect `prefers-reduced-motion`; animation khong chan task va khong tu dong lap vo han.
- Error gan voi field va co summary cho form dai.
- Locale `en`/`vi-VN`, dinh dang tien va thoi gian theo shop/request context; khong hard-code VND hoac `vi-VN`.

## Performance va rendering

- SSR HTML cho shell, navigation, catalog va state quan trong.
- JavaScript hydrate theo island/feature, khong hydrate toan bo page neu khong can.
- Khong fetch lai du lieu SSR ngay sau mount neu khong co freshness reason.
- Public image co dimensions/aspect ratio; critical content khong bi day layout.
- Cart/checkout controls fail closed neu metadata SSR khong hop le.
- Tranh polling vo han. Dung server-provided next-attempt/retry hint hoac user refresh co chu dich.

## Required state vocabulary

Dung mot vocabulary chung, nhung copy theo domain:

| UI state | Khi dung | CTA mau |
| --- | --- | --- |
| `loading` | Dang lay projection/action | Khong duplicate request |
| `empty` | Query hop le, khong co record | Tao/ket noi/di toi setup neu co contract |
| `success` | Mutation da commit | Hien result + next step |
| `warning` | Van dung duoc nhung co risk/drift | Review/check |
| `blocked` | Business invariant ngan action | Fix prerequisite |
| `waiting_user` | Can seller/buyer lam tiep | Hien huong dan cu the |
| `waiting_provider` | Da gui, cho provider | Refresh theo bounded policy |
| `retryable` | Loi tam thoi, co the thu lai | Retry cung idempotency key |
| `error` | Khong tiep tuc duoc | Safe code/request ID |
| `forbidden` | Auth co nhung khong quyen | Quay lai safe surface |
| `plan_limited` | Server limit/feature chan | Billing/read-only explanation |
| `suspended` | Shop/resource bi khoa | Khong co bypass CTA |

## Form va mutation pattern

1. SSR/action policy xac dinh visible/enabled.
2. Validate client chi de feedback nhanh; server van validate lai.
3. Tao stable idempotency key cho mot payload logical.
4. Gui `Origin`, cookie session, `X-CSRF-Token`; them `Idempotency-Key` va `expectedVersion` khi contract yeu cau.
5. Lock duplicate submit; co pending copy cu the.
6. Map safe error code sang copy; voi `409` reload projection truoc khi cho retry.
7. Xoa secret/plaintext khoi DOM/input/memory sau submit thanh cong hoac huy.

## Visual freedom

Doi moi co the thay doi typography, color, grid, navigation shell, card/table language, icon, illustration va motion. Tuy nhien:

- storefront phai cho merchant brand chi phoi, trong khi semantic risk/payment/fulfillment color van nhat quan;
- admin nen uu tien density, evidence va consequence;
- seller workspace nen uu tien task/health va cross-shop clarity;
- marketing co the editorial/expressive nhung pricing phai dung runtime data;
- khong dung mot theme trung tinh giong nhau cho ca bon surface neu lam mat context.
