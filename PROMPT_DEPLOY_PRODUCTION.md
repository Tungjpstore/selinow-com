# Prompt cho AI Agent: Deploy Landing Page v3 lên Production

## Context

Project: **selinow-com** (SaaS platform trên Cloudflare Workers + D1)
Branch hiện tại: **main** (đã merge PR #1: Landing page v3 redesign + auth OTP + onboarding)
Commit HEAD: **9d18682** (Merge commit của PR #1)

### Đã hoàn thành

- ✅ Landing page v3 redesign với indigo palette, SVG assets, hero canvas animation
- ✅ Auth system: email OTP, password login/recovery, forgot/reset password
- ✅ Onboarding quickstart với presets
- ✅ PR #1 merged vào main
- ✅ Cloudflare wrangler đã đăng nhập với tài khoản `tungbipdz@gmail.com`
- ✅ Account ID: `ef250a88911fd24073cb73d1c07e0218`
- ✅ Zone ID: `ce1536fca500680c544662e361ed869b`
- ✅ Worker name: `selinow-com-production`

### Trạng thái hiện tại

- `npm run check`: 0 lỗi
- `npm run lint`: sạch
- `npm run test`: 2450 tests pass (313 files)
- `npm run build`: thành công
- `npm run deploy:dry-run`: thành công (local)

## Blockers cần giải quyết

Pipeline release production có nhiều gates bảo vệ. **Tất cả đều là deliberate security controls**, không thể bypass. Cần hoàn thành theo thứ tự:

### Blocker 1: Provision Worker Secrets (10 secrets)

Các secrets sau chưa được set trong Cloudflare Worker production environment:

```
CLOUDFLARE_API_TOKEN
CREDENTIAL_KEK_V1
DODO_PAYMENTS_API_KEY
DODO_PAYMENTS_WEBHOOK_KEY
EXPORT_KEK_V1
IDENTIFIER_HMAC_SECRET
INVENTORY_KEK_V1
MAGIC_LINK_SECRET
SESSION_SECRET
TURNSTILE_SECRET_KEY
```

**Hành động:**

```bash
# Chạy từng lệnh sau, nhập giá trị secret khi được prompt
wrangler secret put CLOUDFLARE_API_TOKEN --env production
wrangler secret put CREDENTIAL_KEK_V1 --env production
wrangler secret put DODO_PAYMENTS_API_KEY --env production
wrangler secret put DODO_PAYMENTS_WEBHOOK_KEY --env production
wrangler secret put EXPORT_KEK_V1 --env production
wrangler secret put IDENTIFIER_HMAC_SECRET --env production
wrangler secret put INVENTORY_KEK_V1 --env production
wrangler secret put MAGIC_LINK_SECRET --env production
wrangler secret put SESSION_SECRET --env production
wrangler secret put TURNSTILE_SECRET_KEY --env production
```

**Lưu ý:**
- `CLOUDFLARE_API_TOKEN` cần có quyền: Workers Scripts Edit, D1 Edit, Account Read
- `CREDENTIAL_KEK_V1`, `EXPORT_KEK_V1`, `INVENTORY_KEK_V1` là encryption keys (32 bytes hex)
- `SESSION_SECRET`, `IDENTIFIER_HMAC_SECRET`, `MAGIC_LINK_SECRET` là random strings (32+ chars)
- `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY` lấy từ Dodo Payments dashboard
- `TURNSTILE_SECRET_KEY` lấy từ Cloudflare Turnstile dashboard

### Blocker 2: First Production Bootstrap

Đây là lần đầu tiên deploy production sau merge, cần xác nhận thủ công:

```bash
node scripts/production-bootstrap.mjs --confirm-first-production-bootstrap --confirm-production
```

**Lưu ý:** Script này sẽ:
- Validate infrastructure state
- Generate initial production evidence artifact
- Chạy các checks: backup, restore drill, migration status

### Blocker 3: Generate Production Backup

Sau khi có `CLOUDFLARE_API_TOKEN`, tạo backup production database:

```bash
node scripts/backup.mjs --env production --confirm-production
```

**Output:** `.wrangler/backups/production/bkp_*/snapshot.json`

### Blocker 4: Run Restore Drill

Test restore backup để đảm bảo có thể rollback:

```bash
node scripts/restore-drill.mjs --env production --confirm-production
```

**Output:** `.wrangler/restore-drills/production/rdr_*.json`

### Blocker 5: Generate Release Manifest

Tạo release manifest cho commit hiện tại:

```bash
node scripts/release-manifest.mjs
```

**Output:** `.wrangler/releases/production/prd_*/release-manifest.json`

### Blocker 6: Generate Quality Evidence

Chạy full quality gate (check + lint + test + build + deploy dry-runs):

```bash
npm run release:quality:evidence -- --write
```

**Output:** `.wrangler/release/production-evidence.json`

Script này sẽ chạy:
- `npm run check`
- `npm run lint`
- `npx tsc --noEmit`
- `npm run test`
- `npm run build`
- `npm run build:staging`
- `npm audit --audit-level=high`
- `npm run deploy:dry-run`
- `npm run deploy:staging:dry-run`
- `git diff --check`

### Blocker 7: Generate Owner Approvals

5 owners cần approve trong evidence artifact:

```json
{
  "approvals": {
    "dataOwner": "pending",
    "paymentOwner": "pending",
    "releaseOwner": "pending",
    "securityOwner": "pending",
    "supportOwner": "pending"
  }
}
```

**Hành động:** Mỗi owner review evidence artifact và cập nhật status từ `"pending"` → `"approved"` (hoặc `"denied"` với lý do).

### Blocker 8: Legal/Support Evidence

Chưa có artifact: `.wrangler/release/legal-support-evidence.json`

**Nội dung cần:**
- Contracting legal entity
- Registered address + tax identity
- Governing law + dispute forum
- Digital goods refund rules
- Abuse/copyright takedown
- Seller responsibilities
- PayOS settlement boundary
- Dodo Merchant of Record

### Blocker 9: Provider Acceptance Evidence

Chưa có UAT evidence cho:
- Telegram Bot
- WhatsApp Cloud API
- Zalo OA
- Discord Bot

**Hành động:** Chạy UAT flows và generate artifacts:

```bash
node scripts/telegram-bot-uat.mjs --env production
node scripts/whatsapp-uat.mjs --env production
node scripts/zalo-uat.mjs --env production
node scripts/discord-uat.mjs --env production
```

### Blocker 10: Commerce Provider Evidence

Chưa có UAT evidence cho PayOS và Dodo:

```bash
node scripts/payos-uat.mjs --env production
node scripts/dodo-uat.mjs --env production
```

### Blocker 11: Monitoring Evidence

Chưa có monitoring artifact: `.wrangler/release/monitoring-evidence.json`

**Nội dung cần:**
- Alerting configuration
- Budget alerts
- Dashboard URLs
- Log aggregation endpoints

### Blocker 12: Pilot Evidence

Chưa có pilot artifact: `.wrangler/release/pilot-evidence.json`

**Nội dung cần:**
- Pilot shop count (≥1)
- Pilot shop IDs
- Pilot period
- Pilot metrics (orders, revenue, error rate)

### Blocker 13: Rollback Evidence

Chưa có rollback candidate và rehearsal:

```bash
node scripts/rollback-rehearsal.mjs --env production --confirm-production
```

**Output:** `.wrangler/release/rollback-evidence.json`

### Blocker 14: Secret Inventory

Chưa có secret inventory artifact:

```bash
node scripts/secret-inventory.mjs --env production
```

**Output:** `.wrangler/release/secret-inventory.json`

## Sequence thực hiện

Sau khi hoàn thành tất cả blockers trên, chạy theo thứ tự:

### Step 1: Validate pipeline

```bash
npm run release:production:dry-run
```

Script này sẽ chạy 16 bước kiểm tra:
1. `npm run check`
2. `npm run lint`
3. `npx tsc --noEmit`
4. `npm run test`
5. `npm run build`
6. `npm run build:staging`
7. `npm audit --audit-level=high`
8. `npm run deploy:dry-run`
9. `npm run deploy:staging:dry-run`
10. `git diff --check`
11. Backup plan
12. Restore drill plan
13. Database preflight
14. Migration status
15. Worker deploy dry-run
16. Production config doctor

**Expected:** Tất cả 16 steps PASS

### Step 2: Deploy thật

```bash
npm run deploy -- --env production --confirm-production --release-manifest .wrangler/releases/production/prd_*/release-manifest.json
```

Script này sẽ:
1. Build production
2. Upload worker script
3. Deploy version (candidate → 100%)
4. Apply production triggers
5. Apply continuation routes
6. Verify worker identity
7. Rollback tự động nếu có lỗi

### Step 3: Verify deployment

```bash
# Check worker version
wrangler deployments list --env production

# Check health
curl -s https://selinow.com/api/health | jq

# Check marketing page
curl -s https://selinow.com/ | grep "l3-hero-canvas"

# Check locale routing (VN IP)
curl -s -H "Accept-Language: vi-VN" https://selinow.com/ | grep "lang=\"vi-VN\""

# Check locale routing (EN)
curl -s -H "Accept-Language: en-US" https://selinow.com/ | grep "lang=\"en\""
```

## Rollback procedure

Nếu có lỗi sau deploy:

```bash
# Rollback về version trước
node scripts/deploy.mjs --env production --confirm-production --rollback
```

Hoặc manual:

```bash
# List versions
wrangler deployments list --env production

# Rollback về specific version
wrangler deployments rollback <VERSION_ID> --env production
```

## Safety gates

Pipeline này được thiết kế để **không thể deploy nếu thiếu evidence**. Đây là intentional security:

- Không có API token → không backup được → không deploy được
- Không có evidence artifacts → release-doctor fail → deploy fail
- Không có owner approvals → admission check fail
- Tree dirty → admission check fail
- Migration chưa run → database admission fail

**Không được:**
- Bypass checks bằng cách edit scripts
- Comment out admission gates
- Force deploy bằng cách dùng `wrangler deploy` trực tiếp (bỏ qua pipeline)

**Được:**
- Chạy từng step riêng lẻ để debug
- Re-run evidence generation nếu có thay đổi
- Rollback nếu cần

## Verification checklist

Sau khi deploy thành công, verify:

- [ ] Worker version mới active (check `wrangler deployments list`)
- [ ] Marketing page load nhanh (<2s TTFB)
- [ ] Hero canvas animation chạy (check DevTools → Elements → `<canvas>`)
- [ ] Locale routing hoạt động (VN → vi-VN, US → en)
- [ ] Auth flows hoạt động (login, OTP, forgot password)
- [ ] Onboarding flow hoạt động (dashboard → quickstart)
- [ ] Storefront không bị ảnh hưởng (check tenant domain)
- [ ] Telegram bot vẫn hoạt động
- [ ] No errors trong Cloudflare logs (`wrangler tail --env production`)
- [ ] No errors trong Sentry (nếu có)

## Troubleshooting

### Error: `production_bootstrap_backup_evidence_stale`

**Nguyên nhân:** Backup evidence cũ hơn 24 giờ hoặc reference commit khác HEAD

**Fix:** Chạy lại backup

```bash
node scripts/backup.mjs --env production --confirm-production
```

### Error: `quality_evidence_candidate_mismatch`

**Nguyên nhân:** Tree dirty hoặc commit SHA không match

**Fix:** Đảm bảo tree clean, sau đó regenerate

```bash
git status  # should be clean
npm run release:quality:evidence -- --write
```

### Error: `production_release_manifest_required`

**Nguyên nhân:** Chưa generate release manifest

**Fix:**

```bash
node scripts/release-manifest.mjs
```

### Error: `cloudflare_d1_api_token_missing`

**Nguyên nhân:** Không có `CLOUDFLARE_API_TOKEN` secret

**Fix:**

```bash
wrangler secret put CLOUDFLARE_API_TOKEN --env production
```

## Contact

Nếu gặp blockers không giải quyết được:
- Check `docs/IMPLEMENTATION_STATUS.md` để biết NO-GO gates
- Review `docs/marketing-redesign/CONTEXT_PLAN.md` cho landing page context
- Check `.wrangler/release/` cho evidence artifacts hiện tại

## Final note

Pipeline này được thiết kế để đảm bảo **zero-downtime production deployment** với **automatic rollback** nếu có lỗi. Mỗi step đều có purpose và không thể skip. Hoàn thành theo sequence sẽ đảm bảo deploy an toàn và có thể rollback.

**Thời gian ước tính:** 2-4 giờ (bao gồm waiting cho approvals)

**Risk level:** LOW nếu hoàn thành tất cả blockers, HIGH nếu skip bất kỳ step nào.
