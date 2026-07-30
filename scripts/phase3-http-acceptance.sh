#!/usr/bin/env bash
set -euo pipefail

acceptance_dir="$(mktemp -d)"
base_url="http://phase3-acceptance.localhost:4321"
resolve_arg="phase3-acceptance.localhost:4321:127.0.0.1"
variant_id="var_32888888-8888-4888-8888-888888888888"
run_id="$(date +%s)"

npx wrangler d1 execute PLATFORM_DB --local --command \
  "UPDATE orders SET status = 'expired', payment_status = 'expired', fulfillment_status = 'unfulfilled' WHERE shop_id = 'shp_32222222-2222-4222-8222-222222222222' AND status = 'pending_payment'; UPDATE inventory_keys SET status = 'available', reservation_token = NULL, reserved_order_item_id = NULL, reserved_until = NULL WHERE shop_id = 'shp_32222222-2222-4222-8222-222222222222' AND status = 'reserved'; UPDATE product_variants SET price_minor = 100000, version = 1 WHERE id = '$variant_id';" >/dev/null

create_cart() {
  local buyer="$1"
  local price="$2"
  local version="$3"
  local cart_id
  local cart_token

  jq -nc --arg variant "$variant_id" '{items:[{variantId:$variant,quantity:1}],locale:"vi"}' |
    curl -sS --resolve "$resolve_arg" -H 'Content-Type: application/json' --data @- "$base_url/api/store/cart" > "$acceptance_dir/cart-$buyer.json"
  cart_id="$(jq -r '.cartId' "$acceptance_dir/cart-$buyer.json")"
  cart_token="$(jq -r '.cartToken' "$acceptance_dir/cart-$buyer.json")"
  jq -nc --arg id "$cart_id" --arg token "$cart_token" '{cartId:$id,cartToken:$token}' |
    curl -sS --resolve "$resolve_arg" -H 'Content-Type: application/json' --data @- "$base_url/api/store/quote" > "$acceptance_dir/quote-$buyer.json"
  jq -nc --arg id "$cart_id" --arg token "$cart_token" --arg variant "$variant_id" --argjson price "$price" --argjson version "$version" \
    '{cartId:$id,cartToken:$token,expected:[{variantId:$variant,variantVersion:$version,unitPriceMinor:$price}]}' > "$acceptance_dir/checkout-$buyer.json"
}

create_cart "stale" 100000 1
npx wrangler d1 execute PLATFORM_DB --local --command \
  "UPDATE product_variants SET price_minor = 110000, version = 2 WHERE id = '$variant_id';" >/dev/null
curl -sS --resolve "$resolve_arg" -H 'Content-Type: application/json' -H "Idempotency-Key: phase3-stale-$run_id" \
  --data @"$acceptance_dir/checkout-stale.json" "$base_url/api/store/checkout" > "$acceptance_dir/result-stale.json"

create_cart "one" 110000 2
create_cart "two" 110000 2
curl -sS --resolve "$resolve_arg" -H 'Content-Type: application/json' -H "Idempotency-Key: phase3-one-$run_id" \
  --data @"$acceptance_dir/checkout-one.json" "$base_url/api/store/checkout" > "$acceptance_dir/result-one.json" &
pid_one=$!
curl -sS --resolve "$resolve_arg" -H 'Content-Type: application/json' -H "Idempotency-Key: phase3-two-$run_id" \
  --data @"$acceptance_dir/checkout-two.json" "$base_url/api/store/checkout" > "$acceptance_dir/result-two.json" &
pid_two=$!
wait "$pid_one"
wait "$pid_two"

winner="$(jq -r 'if .ok then "one" else empty end' "$acceptance_dir/result-one.json")"
if [[ -z "$winner" ]]; then winner="two"; fi
winner_key="phase3-$winner-$run_id"
curl -sS --resolve "$resolve_arg" -H 'Content-Type: application/json' -H "Idempotency-Key: $winner_key" \
  --data @"$acceptance_dir/checkout-$winner.json" "$base_url/api/store/checkout" > "$acceptance_dir/result-replay.json"
order_id="$(jq -r '.order.orderId' "$acceptance_dir/result-replay.json")"
order_token="$(jq -r '.order.orderToken' "$acceptance_dir/result-replay.json")"
curl -sS --resolve "$resolve_arg" -H "X-Order-Access-Token: $order_token" \
  "$base_url/api/store/orders/$order_id" > "$acceptance_dir/order-valid.json"
curl -sS --resolve "$resolve_arg" -H 'X-Order-Access-Token: invalid-order-token-value' \
  "$base_url/api/store/orders/$order_id" > "$acceptance_dir/order-invalid.json"

printf 'stale_checkout=%s\n' "$(jq -r '.code' "$acceptance_dir/result-stale.json")"
printf 'success_count=%s\n' "$(jq -s '[.[] | select(.ok == true)] | length' "$acceptance_dir/result-one.json" "$acceptance_dir/result-two.json")"
printf 'unavailable_count=%s\n' "$(jq -s '[.[] | select(.code == "inventory_unavailable")] | length' "$acceptance_dir/result-one.json" "$acceptance_dir/result-two.json")"
printf 'idempotent_replay=%s\n' "$(jq -n --arg first "$(jq -r '.order.orderId' "$acceptance_dir/result-$winner.json")" --arg replay "$(jq -r '.order.orderId' "$acceptance_dir/result-replay.json")" '$first == $replay')"
printf 'order_access=%s\n' "$(jq -r '.ok' "$acceptance_dir/order-valid.json")"
printf 'invalid_order_access=%s\n' "$(jq -r '.code' "$acceptance_dir/order-invalid.json")"
printf 'artifacts=%s\n' "$acceptance_dir"
