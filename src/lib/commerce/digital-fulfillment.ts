import { AppError } from "../core/errors";
import { resolveOrderChannelAttribution } from "../channels/attribution";
import { TELEGRAM_CHANNEL_CODE, WEBSITE_CHANNEL_CODE } from "../channels/builtins";
import { decryptInventoryKey } from "../crypto/inventory";
import { resolveEncryptionKey } from "../crypto/keyring";
import type { AppBindings } from "../platform/bindings";
import { decryptGeneratedLicenseArtifact, type EncryptedGeneratedLicenseArtifact } from "./generated-license-crypto";
import {
  getPaymentFulfillmentEligibility,
  getPrincipalPaymentFulfillmentEligibility,
} from "../payments/store";

export type DigitalFulfillmentItem = { productTitle: string; value: string; variantTitle: string };
export type DigitalFulfillmentView = { items: readonly DigitalFulfillmentItem[]; orderId: string };

type KeyRow = {
  ciphertextB64: string;
  ivB64: string;
  keyVersion: string;
  productTitle: string;
  variantId: string;
  variantTitle: string;
};

type GeneratedArtifactRow = EncryptedGeneratedLicenseArtifact & {
  artifactId: string;
  productTitle: string;
  requestId: string;
  variantTitle: string;
};

const TELEGRAM_ORDER_ATTRIBUTION = resolveOrderChannelAttribution(TELEGRAM_CHANNEL_CODE);
const WEBSITE_ORDER_ATTRIBUTION = resolveOrderChannelAttribution(WEBSITE_CHANNEL_CODE);

async function revealAllocatedKeys(input: { connectionId?: string | null; customerId?: string; env: AppBindings; orderPublicId: string; shopId: string; sourceChannel?: "telegram" | "web" }): Promise<DigitalFulfillmentView> {
  const customerPredicate = input.customerId === undefined ? "" : " AND orders.customer_id = ?";
  const sourcePredicate = input.sourceChannel === undefined ? "" : " AND orders.source_channel = ?";
  const attributionPredicate = input.sourceChannel === "telegram"
    ? ` AND EXISTS (
        SELECT 1 FROM order_channel_attributions AS attribution
        WHERE attribution.shop_id = orders.shop_id
          AND attribution.order_id = orders.id
          AND attribution.channel_code = ?
          AND attribution.adapter_version = ?
          AND attribution.connection_id IS ?
      )`
    : input.sourceChannel === "web"
      ? ` AND (
          NOT EXISTS (
            SELECT 1 FROM order_channel_attributions AS attribution
            WHERE attribution.shop_id = orders.shop_id
              AND attribution.order_id = orders.id
          )
          OR EXISTS (
            SELECT 1 FROM order_channel_attributions AS attribution
            WHERE attribution.shop_id = orders.shop_id
              AND attribution.order_id = orders.id
              AND attribution.channel_code = ?
              AND attribution.adapter_version = ?
              AND attribution.connection_id IS NULL
          )
        )`
      : "";
  const values: Array<number | string | null> = [input.orderPublicId, input.shopId];
  if (input.customerId !== undefined) values.push(input.customerId);
  if (input.sourceChannel !== undefined) values.push(input.sourceChannel);
  if (input.sourceChannel === "telegram") {
    values.push(
      TELEGRAM_ORDER_ATTRIBUTION.channelCode,
      TELEGRAM_ORDER_ATTRIBUTION.adapterVersion,
      input.connectionId ?? null,
    );
  } else if (input.sourceChannel === "web") {
    values.push(
      WEBSITE_ORDER_ATTRIBUTION.channelCode,
      WEBSITE_ORDER_ATTRIBUTION.adapterVersion,
    );
  }
  const keys = await input.env.PLATFORM_DB.prepare(`
    SELECT order_items.product_title AS productTitle, order_items.variant_title AS variantTitle,
      inventory_keys.ciphertext_b64 AS ciphertextB64, inventory_keys.iv_b64 AS ivB64,
      inventory_keys.key_version AS keyVersion, inventory_keys.variant_id AS variantId
    FROM orders
    INNER JOIN fulfillment_items
      ON fulfillment_items.shop_id = orders.shop_id
    INNER JOIN fulfillments
      ON fulfillments.id = fulfillment_items.fulfillment_id
      AND fulfillments.shop_id = orders.shop_id
      AND fulfillments.order_id = orders.id
      AND fulfillments.fulfillment_type = 'digital_keys'
      AND fulfillments.state = 'fulfilled'
    INNER JOIN inventory_keys
      ON inventory_keys.id = fulfillment_items.inventory_key_id
      AND inventory_keys.shop_id = orders.shop_id
      AND inventory_keys.status = 'sold'
    INNER JOIN order_items
      ON order_items.id = fulfillment_items.order_item_id
      AND order_items.shop_id = orders.shop_id
      AND order_items.order_id = orders.id
    WHERE orders.public_id = ? AND orders.shop_id = ?
      AND orders.payment_status = 'paid'
      AND orders.status IN ('processing', 'completed')
      ${customerPredicate}${sourcePredicate}${attributionPredicate}
    ORDER BY fulfillment_items.id
  `).bind(...values).all<KeyRow>();
  return {
    items: await Promise.all(keys.results.map(async (key) => {
      const encryptionKey = resolveEncryptionKey(input.env, "inventory", key.keyVersion);
      return {
        productTitle: key.productTitle,
        value: await decryptInventoryKey({ ...key, kek: encryptionKey.kek, keyVersion: encryptionKey.version, shopId: input.shopId }),
        variantTitle: key.variantTitle,
      };
    })),
    orderId: input.orderPublicId,
  };
}

async function hasGeneratedLicenseSchema(env: AppBindings): Promise<boolean> {
  try {
    const row = await env.PLATFORM_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generated_license_artifacts' LIMIT 1",
    ).first<{ name: string }>();
    return row !== null;
  } catch {
    // Legacy test doubles and pre-migration environments use the pooled-key path only.
    return false;
  }
}

async function revealGeneratedArtifacts(input: { connectionId?: string | null; customerId?: string; env: AppBindings; orderPublicId: string; shopId: string; sourceChannel?: "telegram" | "web" }): Promise<readonly DigitalFulfillmentItem[]> {
  if (!(await hasGeneratedLicenseSchema(input.env))) return [];
  const customerPredicate = input.customerId === undefined ? "" : " AND orders.customer_id = ?";
  const sourcePredicate = input.sourceChannel === undefined ? "" : " AND orders.source_channel = ?";
  const attributionPredicate = input.sourceChannel === "telegram"
    ? ` AND EXISTS (
        SELECT 1 FROM order_channel_attributions AS attribution
        WHERE attribution.shop_id = orders.shop_id
          AND attribution.order_id = orders.id
          AND attribution.channel_code = ?
          AND attribution.adapter_version = ?
          AND attribution.connection_id IS ?
      )`
    : input.sourceChannel === "web"
      ? ` AND (
          NOT EXISTS (
            SELECT 1 FROM order_channel_attributions AS attribution
            WHERE attribution.shop_id = orders.shop_id
              AND attribution.order_id = orders.id
          )
          OR EXISTS (
            SELECT 1 FROM order_channel_attributions AS attribution
            WHERE attribution.shop_id = orders.shop_id
              AND attribution.order_id = orders.id
              AND attribution.channel_code = ?
              AND attribution.adapter_version = ?
              AND attribution.connection_id IS NULL
          )
        )`
      : "";
  const values: Array<number | string | null> = [input.orderPublicId, input.shopId, new Date().toISOString()];
  if (input.customerId !== undefined) values.push(input.customerId);
  if (input.sourceChannel !== undefined) values.push(input.sourceChannel);
  if (input.sourceChannel === "telegram") {
    values.push(
      TELEGRAM_ORDER_ATTRIBUTION.channelCode,
      TELEGRAM_ORDER_ATTRIBUTION.adapterVersion,
      input.connectionId ?? null,
    );
  } else if (input.sourceChannel === "web") {
    values.push(
      WEBSITE_ORDER_ATTRIBUTION.channelCode,
      WEBSITE_ORDER_ATTRIBUTION.adapterVersion,
    );
  }
  const artifacts = await input.env.PLATFORM_DB.prepare(`
    SELECT artifact.id AS artifactId, artifact.request_id AS requestId,
      artifact.ciphertext_b64 AS ciphertextB64, artifact.iv_b64 AS ivB64,
      artifact.key_version AS keyVersion, artifact.artifact_fingerprint AS artifactFingerprint,
      artifact.format, order_items.product_title AS productTitle,
      order_items.variant_title AS variantTitle
    FROM orders
    INNER JOIN generated_license_requests AS request
      ON request.order_id = orders.id AND request.shop_id = orders.shop_id
      AND request.status = 'succeeded'
    INNER JOIN generated_license_requirement_snapshots AS snapshot
      ON snapshot.id = request.requirement_snapshot_id
      AND snapshot.shop_id = request.shop_id
    INNER JOIN order_items
      ON order_items.id = snapshot.order_item_id
      AND order_items.shop_id = snapshot.shop_id
      AND order_items.order_id = orders.id
    INNER JOIN entitlements AS entitlement
      ON entitlement.id = request.entitlement_id AND entitlement.shop_id = request.shop_id
      AND entitlement.status = 'active'
      AND (entitlement.access_expires_at IS NULL OR entitlement.access_expires_at > ?)
    INNER JOIN generated_license_artifacts AS artifact
      ON artifact.request_id = request.id AND artifact.shop_id = request.shop_id
      AND artifact.status = 'active'
    WHERE orders.public_id = ? AND orders.shop_id = ?
      AND orders.payment_status = 'paid'
      AND orders.status IN ('processing', 'completed')
      ${customerPredicate}${sourcePredicate}${attributionPredicate}
    ORDER BY order_items.id, request.id, artifact.ordinal
  `).bind(values[2], values[0], values[1], ...values.slice(3)).all<GeneratedArtifactRow>();
  return Promise.all(artifacts.results.map(async (artifact) => {
    const encryptionKey = resolveEncryptionKey(input.env, "inventory", artifact.keyVersion);
    return {
      productTitle: artifact.productTitle,
      value: await decryptGeneratedLicenseArtifact(artifact, {
        artifactId: artifact.artifactId,
        format: artifact.format,
        kek: encryptionKey.kek,
        keyVersion: encryptionKey.version,
        requestId: artifact.requestId,
        shopId: input.shopId,
      }),
      variantTitle: artifact.variantTitle,
    };
  }));
}

async function revealDigitalFulfillment(input: { connectionId?: string | null; customerId?: string; env: AppBindings; orderPublicId: string; shopId: string; sourceChannel?: "telegram" | "web" }): Promise<DigitalFulfillmentView> {
  const [allocated, generated] = await Promise.all([
    revealAllocatedKeys(input),
    revealGeneratedArtifacts(input),
  ]);
  const items = [...allocated.items, ...generated];
  if (items.length === 0) throw new AppError("order_not_ready", 409);
  return { items, orderId: input.orderPublicId };
}

export async function revealWebsiteDigitalFulfillment(input: { env: AppBindings; orderPublicId: string; orderToken: string; shopId: string }): Promise<DigitalFulfillmentView> {
  const eligibility = await getPaymentFulfillmentEligibility(input);
  if (!eligibility.eligible) throw new AppError("order_not_ready", 409);
  return revealDigitalFulfillment({ ...input, sourceChannel: "web" });
}

export async function revealPrincipalDigitalFulfillment(input: { connectionId?: string | null; customerId: string; env: AppBindings; orderPublicId: string; shopId: string; sourceChannel?: "telegram" }): Promise<DigitalFulfillmentView> {
  const eligibility = await getPrincipalPaymentFulfillmentEligibility(input);
  if (!eligibility.eligible) throw new AppError("order_not_ready", 409);
  return revealDigitalFulfillment(input);
}
