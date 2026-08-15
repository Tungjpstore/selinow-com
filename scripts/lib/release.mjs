import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertProductionWorkerIdentityAdmission,
  assertProductionWorkerVersionAdmission,
  parseProductionWorkerDeployableVersionInventory,
  requireCloudflareWorkerDeployToken,
  repositoryRoot,
} from "./platform.mjs";
import { assertFreshProductionContinuationEvidence } from "./backup.mjs";
import { runWrangler } from "./cli.mjs";
import { validateCommerceUatArtifacts } from "./commerce-uat-evidence.mjs";

export const REQUIRED_PRODUCTION_VARS = [
  "ACTIVE_CREDENTIAL_KEY_VERSION",
  "ACTIVE_INVENTORY_KEY_VERSION",
  "API_ORIGIN",
  "APP_ENV",
  "CANARY_HOSTNAME",
  "CLOUDFLARE_ZONE_ID",
  "CREDENTIAL_KEY_VERSION",
  "DASHBOARD_ORIGIN",
  "DEFAULT_CURRENCY",
  "DEFAULT_LOCALE",
  "DEFAULT_TIMEZONE",
  "DODO_PAYMENTS_ENVIRONMENT",
  "DODO_PAYMENTS_WEBHOOK_PUBLIC_ID",
  "EMAIL_FROM_ADDRESS",
  "EMAIL_FROM_NAME",
  "EXPORT_KEY_VERSION",
  "INVENTORY_KEY_VERSION",
  "LOG_LEVEL",
  "MAGIC_LINK_GLOBAL_RATE_LIMIT",
  "MAGIC_LINK_RATE_LIMIT_WINDOW_SECONDS",
  "MAGIC_LINK_REQUESTER_RATE_LIMIT",
  "MEDIA_PUBLIC_BASE_URL",
  "PLATFORM_BASE_DOMAIN",
  "PLATFORM_NAME",
  "PLATFORM_ORIGIN",
  "RESOURCE_MANIFEST_VERSION",
  "SAAS_CNAME_TARGET",
  "SESSION_COOKIE_NAME",
  "STOREFRONT_CART_RATE_LIMIT",
  "STOREFRONT_CHECKOUT_RATE_LIMIT",
  "STOREFRONT_RATE_LIMIT_WINDOW_SECONDS",
  "STOREFRONT_TURNSTILE_THRESHOLD",
  "TELEGRAM_WEBHOOK_MAX_CONNECTIONS",
  "TURNSTILE_SITE_KEY",
];

export const REQUIRED_WORKER_SECRET_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "CREDENTIAL_KEK_V1",
  "DODO_PAYMENTS_API_KEY",
  "DODO_PAYMENTS_WEBHOOK_KEY",
  "EXPORT_KEK_V1",
  "IDENTIFIER_HMAC_SECRET",
  "INVENTORY_KEK_V1",
  "MAGIC_LINK_SECRET",
  "SESSION_SECRET",
  "TURNSTILE_SECRET_KEY",
];

export const REQUIRED_PROVIDER_ACCEPTANCE_KEYS = [
  "telegramBot",
  "telegramMiniApp",
  "zaloMiniApp",
  "zaloOa",
  "whatsappCloud",
  "discord",
];

export const RELEASE_CHANNEL_KEYS = ["website", ...REQUIRED_PROVIDER_ACCEPTANCE_KEYS];
export const REQUIRED_COMMERCE_ACCEPTANCE_KEYS = ["payos", "dodo"];
export const REQUIRED_LEGAL_SUPPORT_DECISION_KEYS = Object.freeze([
  "contractingLegalEntity",
  "registeredAddressTaxIdentity",
  "governingLawDisputeForum",
  "digitalGoodsRefundRules",
  "abuseCopyrightTakedown",
  "sellerResponsibility",
  "payosSettlementBoundary",
  "dodoMerchantOfRecord",
  "privacyRolesDsar",
  "retentionDeletionExceptions",
  "platformSupportContact",
  "sellerBuyerSupportBoundary",
]);
export const REQUIRED_SECRET_INVENTORY_SCHEMA_VERSION = 1;
export const REQUIRED_PRODUCTION_ROLLBACK_INVARIANTS = Object.freeze([
  "billing_checkout_sessions_scope_guard",
  "billing_checkout_sessions_scope_update_guard",
  "shop_subscriptions_provider_ref_guard",
  "shop_subscriptions_provider_ref_update_guard",
  "plan_prices_published_reference_guard",
  "plans_public_assignable_insert_guard",
  "plans_public_assignable_update_guard",
  "shop_subscriptions_price_snapshot_presence_guard",
  "shop_subscriptions_price_snapshot_presence_update_guard",
  "shop_subscriptions_price_snapshot_scope_guard",
  "shop_subscriptions_price_snapshot_scope_update_guard",
  "shop_subscriptions_trial_claim_insert_guard",
  "shop_subscriptions_trial_claim_update_guard",
  "shop_customers_anonymized_insert_guard",
  "shop_customers_anonymized_update_guard",
  "checkout_recovery_capabilities_tenant_order_insert_guard",
  "checkout_recovery_capabilities_tenant_order_guard",
  "payment_integrations_provider_claim_generation",
  "payment_integrations_provider_claim_nonce",
  "payment_integrations_provider_claim_state",
  "payment_integrations_provider_claim_target_fingerprint",
  "payment_credentials_provider_claim_nonce",
  "idx_payment_integrations_provider_claim_nonce",
  "payment_integrations_payos_claim_state_insert_guard",
  "payment_integrations_payos_claim_state_update_guard",
  "payment_credentials_payos_claim_scope_insert_guard",
  "payment_credentials_payos_claim_scope_update_guard",
  "payment_integrations_payos_claim_fingerprint_update_guard",
  "payment_credentials_payos_claim_fingerprint_update_guard",
  "payment_integrations_payos_claim_fingerprint_clear_guard",
  "payment_credentials_payos_claim_fingerprint_clear_guard",
  "idx_order_access_recovery_tokens_active_order",
  "idx_order_access_recovery_tokens_previous",
  "idx_order_access_recovery_tokens_replacement",
  "idx_order_access_recovery_tokens_retention",
  "idx_order_access_recovery_tokens_shop_customer",
  "idx_order_access_recovery_tokens_shop_order",
  "idx_orders_shop_id_customer",
  "order_access_recovery_tokens",
  "order_access_recovery_tokens_consume_rotate_order",
  "order_access_recovery_tokens_customer_anonymize",
  "order_access_recovery_tokens_identity_immutable",
  "order_access_recovery_tokens_redaction_guard",
  "order_access_recovery_tokens_scope_insert_guard",
  "order_access_recovery_tokens_terminal_immutable",
  "shop_domains_identity_update_guard",
  "shop_domains_turnstile_active_insert_guard",
  "shop_domains_turnstile_active_update_guard",
  "shops_turnstile_canonical_insert_guard",
  "shops_turnstile_canonical_update_guard",
  "auth_request_admissions",
  "idx_auth_request_admissions_window",
  "idx_auth_request_admissions_requester_window",
  "idx_auth_request_admissions_expiry",
  "idx_auth_request_admissions_subject_window",
  "telegram_updates",
  "telegram_actions",
  "telegram_action_history",
  "idx_telegram_integrations_shop_generation",
  "idx_telegram_actions_generation",
  "idx_telegram_action_history_generation",
  "idx_telegram_updates_generation_processing",
  "idx_telegram_updates_shop_received",
  "idx_telegram_updates_status",
  "outbox_jobs_quarantine_legacy_order_paid_insert",
  "telegram_integrations_generation_switch_required",
  "telegram_integrations_generation_transition_guard",
  "telegram_integrations_delivery_generation_busy_guard",
  "telegram_integrations_archive_actions_on_generation_change",
  "telegram_actions_generation_insert_guard",
  "telegram_actions_legacy_generation_attribute",
  "telegram_updates_generation_claim_guard",
  "telegram_updates_generation_insert_guard",
]);

const PRODUCTION_DATABASE_INVARIANT_REGISTRY = Object.freeze({
  "0078_dodo_billing_hardening.sql": Object.freeze({
    columns: Object.freeze({}),
    objects: Object.freeze({
      billing_checkout_sessions_scope_guard: "ee232682d7c3f5fbd9f5758bb3093b2001599ecd610b417cd002fe57a5c734a3",
      billing_checkout_sessions_scope_update_guard: "dedd8e9d81332f762040b5f921a152a02cc9e8083a1e7c2c7bc56ba896cbd4f3",
      shop_subscriptions_provider_ref_guard: "589a4375cd09461734ab10cca198bdc5a06ccdb534d4d745d289aef2329aaa6d",
      shop_subscriptions_provider_ref_update_guard: "6e0fd7e2c41a7344294bc34514547c3f5dd3a239729310219a2f222e57e7df4b",
    }),
  }),
  "0081_dodo_catalog_contract.sql": Object.freeze({
    columns: Object.freeze({}),
    objects: Object.freeze({
      plan_prices_published_reference_guard: "f01e36d58bc1a6271bf6bcea5325ea74cc3a6fe02882f32ce869232169627e2a",
      plans_public_assignable_insert_guard: "1f26d64dbdae22b3c24e03f060f576fd02de82ad0396bc3ae3995cf7ad566b12",
      plans_public_assignable_update_guard: "4178d72edc41026751defe365b59552543f413ff24800c1b204795880bfc9c98",
      shop_subscriptions_price_snapshot_presence_guard: "6c11041abd06e63e204d41443d84d82ab88dac1fcb55778b30ca69cfbee2454a",
      shop_subscriptions_price_snapshot_presence_update_guard: "140671de929da01f5a41eb97717c7fe54e8789d33148c10b3cbef8c3aa99e2cc",
      shop_subscriptions_price_snapshot_scope_guard: "c554fa734c391b71467f4e70a999c2f73f7d8aff475dc6321a541bdd9ea9279e",
      shop_subscriptions_price_snapshot_scope_update_guard: "ed2cd456ca838d9f20a60bc31d9cc6c4d68ecf06593a76c4183224358813381c",
    }),
  }),
  "0087_integrity_hardening.sql": Object.freeze({
    columns: Object.freeze({}),
    objects: Object.freeze({
      checkout_recovery_capabilities_tenant_order_guard: "0f3b38075413bd31942a131f36c6ea10978ab7e78f31e21198e6950c55c141cb",
      checkout_recovery_capabilities_tenant_order_insert_guard: "14dd928c2991af0e9b589fc3fce725db23dc36e38223e60ffb8dc73e76a6bf98",
      shop_customers_anonymized_insert_guard: "438798587050686f4f1ca7da56a9f9d37eab4c04ec5cb0aa9c48fe0e6fefd70e",
      shop_customers_anonymized_update_guard: "93f26ab3180b34e7c721876adcdf96dfb5d5e026d90145a13488192f439eb469",
      shop_subscriptions_trial_claim_insert_guard: "87b0b44aacac4ff3cd3efa400fe69bcbe0fc2dae1d1748e14908e893ccb763d9",
      shop_subscriptions_trial_claim_update_guard: "c13c78161470d4cf6cb0142ebe71bdf593a9cd688e81453b06b9e70049badd4a",
    }),
  }),
  "0088_payos_provider_claim_fencing.sql": Object.freeze({
    columns: Object.freeze({
      "payment_credentials.provider_claim_nonce": Object.freeze({ defaultValue: null, notNull: 0, primaryKey: 0, type: "TEXT" }),
      "payment_integrations.provider_claim_generation": Object.freeze({ defaultValue: "0", notNull: 1, primaryKey: 0, type: "INTEGER" }),
      "payment_integrations.provider_claim_nonce": Object.freeze({ defaultValue: null, notNull: 0, primaryKey: 0, type: "TEXT" }),
      "payment_integrations.provider_claim_state": Object.freeze({ defaultValue: "'idle'", notNull: 1, primaryKey: 0, type: "TEXT" }),
      "payment_integrations.provider_claim_target_fingerprint": Object.freeze({ defaultValue: null, notNull: 0, primaryKey: 0, type: "TEXT" }),
    }),
    objects: Object.freeze({
      idx_payment_integrations_provider_claim_nonce: "c3769618c6f601d7d8ff2160410c4f8d274583b2a0bfd915c0bdb43437580c1f",
      payment_credentials: "5c28bc5d11ad4a0fe5e1fbb46af999f61d5c1aa3e2bcebecd3e9f68e4b601283",
      payment_credentials_payos_claim_scope_insert_guard: "ca71d5b1965ec92e61ed57caa90cfd6d64a338596972f14b1cab7f34375ccd30",
      payment_credentials_payos_claim_scope_update_guard: "524ca6ad0d9443cc3a0d62937580a4d21bbb829af6bb93589e4c7867d3f83372",
      payment_integrations: "4f1c6a5aaf7f825b06c08a43c5ad3827327a43d7a8361d2dd602bc29d74b5224",
      payment_integrations_payos_claim_state_insert_guard: "d59e9de101ad4c396b1321caeefd69a21dc5740a2942805f0c0816646524b8de",
      payment_integrations_payos_claim_state_update_guard: "ba4a58fa87d7964fd6073d689b9870fee8aa8cd5503362d5bbba106477cb8ba0",
    }),
  }),
  "0089_payos_provider_claim_compatibility.sql": Object.freeze({
    columns: Object.freeze({}),
    objects: Object.freeze({
      payment_credentials_payos_claim_fingerprint_update_guard: "1138afea4b9ad196d64dc2e19e81847a6a9a13861e3d8b773e49392f86d218be",
      payment_integrations_payos_claim_fingerprint_update_guard: "e5c2d27d420af8e0302def762a5bb51218b1c618267c8fd46b188975193e44ed",
    }),
  }),
  "0090_payos_provider_claim_clear_guard.sql": Object.freeze({
    columns: Object.freeze({}),
    objects: Object.freeze({
      payment_credentials_payos_claim_fingerprint_clear_guard: "8a8848633184c67e65f6eab33eb8d6b8453cc2b05056bc6702cc8c2c3cd322c8",
      payment_integrations_payos_claim_fingerprint_clear_guard: "77977a03b5c5c865420f744e88e05a4b7510c2d39d04537fa710ed457d11a20d",
    }),
  }),
  "0091_buyer_order_access_recovery.sql": Object.freeze({
    columns: Object.freeze({
      "order_access_recovery_tokens.previous_order_token_hash": Object.freeze({ defaultValue: null, notNull: 0, primaryKey: 0, type: "TEXT" }),
      "order_access_recovery_tokens.redacted_at": Object.freeze({ defaultValue: null, notNull: 0, primaryKey: 0, type: "TEXT" }),
      "order_access_recovery_tokens.replacement_order_token_hash": Object.freeze({ defaultValue: null, notNull: 0, primaryKey: 0, type: "TEXT" }),
      "order_access_recovery_tokens.retention_expires_at": Object.freeze({ defaultValue: null, notNull: 1, primaryKey: 0, type: "TEXT" }),
    }),
    objects: Object.freeze({
      idx_order_access_recovery_tokens_active_order: "9c6c8e306c21b200c401df228c8c4d5841c8be131a8a0463eb783ce1304d3080",
      idx_order_access_recovery_tokens_previous: "fcaab9aa950d7c101b68cd249560abc8c49f5238808389d17c5cb3464c91b9c3",
      idx_order_access_recovery_tokens_replacement: "5e120c2590220745250211c351884884d89c19278b62caf3e1a3d98777abaef6",
      idx_order_access_recovery_tokens_retention: "629ba27d7de43e857da598318c7eb45c612b9e47b6cd03bf3f0c1939647b0c31",
      idx_order_access_recovery_tokens_shop_customer: "ccff1bb6e90ed8664b87ad876be9cb94f64aeab34bacc33aefb5ebe349cc104e",
      idx_order_access_recovery_tokens_shop_order: "816a119fe4207b6fdf2e9845c0a43d860c113a98b084471424f3e04c7a80fb1b",
      idx_orders_shop_id_customer: "f9750eb5f6457de006402c43ee9fc727bda2141c2538ba0aec7cef1b1dc55c1a",
      order_access_recovery_tokens: "ffb9aacd2977e7fa44978b9d2583dd8a21a9b4bee345b0d0e5cfb966186b46f3",
      order_access_recovery_tokens_consume_rotate_order: "8d9d512b0ba031db1eaad9e9afa8857ce5a4224a2f056e4346bbc9e830342fd5",
      order_access_recovery_tokens_customer_anonymize: "20b3ad414348178ecd291cd879bae73d454c4fee3ae15add064650869fa9e461",
      order_access_recovery_tokens_identity_immutable: "cc4a925c176c6e39de2396fbb81757e5e919d7787240bae6a5358de49c04def8",
      order_access_recovery_tokens_redaction_guard: "fd0880fe0f5466fcc52814086117dcec5c0da5c3a73ef364abc54caf831ceb08",
      order_access_recovery_tokens_scope_insert_guard: "346b8965a2388eaf1f9c0b856b918c09151be98068ddef4d57a982fa7fd79e89",
      order_access_recovery_tokens_terminal_immutable: "857c4d2a35552dd2d9987682cad03ab17b8d09ec89b3f2a45c0b200339994625",
    }),
  }),
  "0092_custom_domain_turnstile_admission.sql": Object.freeze({
    columns: Object.freeze({}),
    objects: Object.freeze({}),
  }),
  "0093_custom_domain_turnstile_runtime_guard.sql": Object.freeze({
    columns: Object.freeze({}),
    objects: Object.freeze({
      shop_domains_identity_update_guard: "03683601b987a31d771c1067d9834cc486dc201075d411476db4cdedeca6afab",
      shop_domains_turnstile_active_insert_guard: "0835ccf4c8c773adeadc52b1dc68871753034d1ad267abfbda05d3a7390293a9",
      shop_domains_turnstile_active_update_guard: "855a8b76a438bdd1baf1624f7190a51714e522a53c60c13c37c8ffeea1510cd6",
      shops_turnstile_canonical_insert_guard: "4bee8c8f97f97c94f1db75f6184d5aa1e5975511c55c2413eec7dd82ba2e721f",
      shops_turnstile_canonical_update_guard: "94522fd8950e45cfca46db8714adaa273f390cdbec1b2c067f13d41ce1b0dc88",
    }),
  }),
  "0094_shop_creation_admission.sql": Object.freeze({
    columns: Object.freeze({}),
    objects: Object.freeze({
      auth_request_admissions: "772097f5ae0b7bd25b9204cd23b3585f2377400f438b47f82cf951164e34fb54",
      idx_auth_request_admissions_expiry: "c1d1f0912034e724af8c68488f77bae0f9dcf9439fdf9eef0bd69b956180ef06",
      idx_auth_request_admissions_requester_window: "0eae88a37e6f001da33ac076fa37527c747d327580fa25b191e13b050d164734",
      idx_auth_request_admissions_subject_window: "fd963cf7fdc62169d6f43742b5d0b8e5dea620fd15feed6b6962675bf61682ac",
      idx_auth_request_admissions_window: "948c62c46ee63a42a09d18ba42f18a352c1c267c6ab23e102944d5c1e68ea73e",
    }),
  }),
  "0095_telegram_generation_and_legacy_outbox_quarantine.sql": Object.freeze({
    columns: Object.freeze({
      "telegram_integrations.generation_state": Object.freeze({ defaultValue: "'active'", notNull: 1, primaryKey: 0, type: "TEXT" }),
      "telegram_integrations.integration_generation": Object.freeze({ defaultValue: "1", notNull: 1, primaryKey: 0, type: "INTEGER" }),
      "telegram_updates.credential_id": Object.freeze({ defaultValue: null, notNull: 0, primaryKey: 0, type: "TEXT" }),
      "telegram_updates.integration_generation": Object.freeze({ defaultValue: null, notNull: 1, primaryKey: 0, type: "INTEGER" }),
    }),
    objects: Object.freeze({
      idx_telegram_integrations_shop_generation: "8244ab8cce535dbe3b8b489f3082b0fdccdb6112ca238d7b39abb38993956768",
      idx_telegram_updates_generation_processing: "aa1078199fc96a2f71bbe1f867223fa5ce12386281653c6f5ce9bdf61ccaa30a",
      idx_telegram_updates_shop_received: "241a38ebc8e45626d8741e2344b3f08f52917d5f9e6e7a08185e2bf5732e0658",
      idx_telegram_updates_status: "aafd2108d00a368c3cc7e2134099f448916d9f6d8602b7fbbbe4d5ab4b37fbfd",
      outbox_jobs_quarantine_legacy_order_paid_insert: "f2b3bac3b51c376153836e7436602c68520f80b6f1623c76d0b2c6caa84ef7e4",
      telegram_integrations_generation_transition_guard: "2415a487ac7f25b137ad87e0243867b66dce287d646ab0f316e33792ac62ba3c",
      telegram_updates_generation_claim_guard: "7fb8e1a635bc62712d8c86567a69fa6d4a22be93e90d681779317c80c57ef25b",
    }),
  }),
  "0096_telegram_runtime_rollback_compatibility.sql": Object.freeze({
    columns: Object.freeze({
      "telegram_updates.integration_generation": Object.freeze({ defaultValue: "0", notNull: 1, primaryKey: 0, type: "INTEGER" }),
    }),
    objects: Object.freeze({
      telegram_credentials_legacy_generation_busy_guard: "b47451f2e2498ee5aaddc7e994e4c014d4df8dc45de2c9ec57537683ab36a354",
      telegram_integrations_generation_switch_required: "61ea60a286589437f7001f8ea30e90ba5e68cea8d774d450ae02928a41507c36",
      telegram_integrations_legacy_generation_fence: "03e8cd6547ea6c89a1d443f4cca80545fffec4504a2b396f1ed339687186ab02",
      telegram_updates: "4ce398c15b026424471d6d699e5f8cf8e04c5029c3221f53653f0717e48ae62f",
      telegram_updates_generation_insert_guard: "6178cbde5fd9e714d6325f9a24461331ae0ce9aacbfdf084a4f105221ce8797e",
      telegram_updates_legacy_generation_attribute: "7283ef2b3b6dda1692a2fddbe16cb8960dbd8babfc07a06cbee22e01cf57716d",
    }),
  }),
  "0097_telegram_action_generation_and_delivery_interlock.sql": Object.freeze({
    columns: Object.freeze({
      "telegram_actions.integration_generation": Object.freeze({ defaultValue: "0", notNull: 1, primaryKey: 0, type: "INTEGER" }),
    }),
    objects: Object.freeze({
      idx_telegram_actions_generation: "d6960dedcc5ffcb23b88729065a272d8ae96f4053f675d08c69d63a794d8d455",
      idx_telegram_action_history_generation: "b6925af5d83920175893f2d79c7681f8984ba0ce288be3e6279c05bcfdfe170f",
      telegram_actions: "b038d4d99ea3b3e31f9d4765374c59f45db9eec272c6bf9d8639a25802299faf",
      telegram_action_history: "94ec8b95a332a5a76b430c8a0981b660ecaa99a288303c9c66028a4ae1fecfd8",
      telegram_actions_generation_insert_guard: "83580b1d23a9ee5add45b43b655d7b221d20ad95fa0b7462c262507c661b18f0",
      telegram_actions_legacy_generation_attribute: "4cb4075100db19dc6d2e55dd69e95a97391465e296d209f3543d34deede3fc15",
      telegram_integrations_delivery_generation_busy_guard: "e36a4c112a73f940b10cde02128dfc58763105a99d4a4e91051cce6dd5103030",
      telegram_integrations_archive_actions_on_generation_change: "7d6c49494aa63ebf9aa37d84dcd8baaf87fca335b42a246f03d7589cd8e500a2",
    }),
  }),
  "0098_auth_email_otp_system.sql": Object.freeze({
    columns: Object.freeze({}),
    objects: Object.freeze({}),
  }),
});


const REQUIRED_SPEC_PATHS = [
  "accountId",
  "environment",
  "hostnames.api",
  "hostnames.dashboard",
  "hostnames.marketing",
  "resources.d1",
  "resources.deadLetterQueue",
  "resources.integrationQueue",
  "resources.notificationQueue",
  "resources.platformCacheKv",
  "resources.privateExports",
  "resources.r2",
  "resources.sessionKv",
  "saas.cnameTarget",
  "saas.fallbackOrigin",
  "workerName",
  "zoneId",
  "zoneName",
];

const REQUIRED_EVIDENCE_PATHS = [
  "approvals.releaseOwner",
  "approvals.supportOwner",
  "approvals.paymentOwner",
  "approvals.dataOwner",
  "approvals.securityOwner",
  "backup.completedAt",
  "backup.providerBookmarkRecorded",
  "backup.restoreDrillCompletedAt",
  "backup.restoreDrillPassed",
  "backup.restoreDrillReportRef",
  "backup.snapshotReportRef",
  "candidateWorkerVersion",
  "commitSha",
  "manualAcceptance.customDomain",
  "manualAcceptance.evidenceRef",
  "manualAcceptance.observedAt",
  "manualAcceptance.paymentSignedEvent",
  "manualAcceptance.telegram",
  "manualAcceptance.website",
  "monitoring.alertsReady",
  "monitoring.budgetAlertsReady",
  "monitoring.dashboardReady",
  "monitoring.evidenceRef",
  "monitoring.observedAt",
  "pilot.shopCount",
  "pilot.evidenceRef",
  "pilot.completedAt",
  "previousWorkerVersion",
  "quality.auditHigh",
  "quality.build",
  "quality.buildStaging",
  "quality.check",
  "quality.deployDryRun",
  "quality.deployStagingDryRun",
  "quality.gitDiffCheck",
  "quality.lint",
  "quality.schemaVersion",
  "quality.test",
  "quality.tscNoEmit",
  "releaseId",
  "rollback.rehearsalEvidenceRef",
  "rollback.rehearsedAt",
  "security.criticalOpen",
  "security.highOpen",
  "staging.accepted",
  "staging.acceptedAt",
  "staging.releaseId",
  "staging.manifestRef",
  "staging.manifestSha256",
  "staging.workerVersion",
  "treeSha",
];

const PLACEHOLDER_PATTERN = /(?:change-me|not-provisioned|placeholder|replace-with|<[^>]+>)/iu;
const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,80}$/u;
const SAFE_NAME_PATTERN = /^[a-z][a-z0-9._-]{2,80}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PRIVATE_RELEASE_ARTIFACT_REF_PATTERN = /^\.wrangler\/releases\/[a-z0-9][a-z0-9._-]{7,80}\/[A-Za-z0-9._/-]+\.json$/u;
const PRIVATE_EVIDENCE_REF_PATTERN = /^(?:private\/|\.wrangler\/releases\/)[A-Za-z0-9._/-]+$/u;
const LEGAL_SUPPORT_ARTIFACT_MODE = "legal_support_decision_checklist";
const CANDIDATE_BOUND_EVIDENCE_SCHEMA_VERSION = 1;
const CANDIDATE_BOUND_EVIDENCE_DEFINITIONS = Object.freeze({
  manualAcceptance: Object.freeze({
    artifactFile: "manual-acceptance.json",
    evidenceKeys: Object.freeze(["customDomain", "paymentSignedEvent", "telegram", "website"]),
    maximumAgeMs: 30 * 24 * 60 * 60_000,
    mode: "manual_acceptance",
    timestampField: "observedAt",
  }),
  monitoring: Object.freeze({
    artifactFile: "monitoring-evidence.json",
    evidenceKeys: Object.freeze(["alertsReady", "budgetAlertsReady", "dashboardReady"]),
    maximumAgeMs: 24 * 60 * 60_000,
    mode: "monitoring_evidence",
    timestampField: "observedAt",
  }),
  pilot: Object.freeze({
    artifactFile: "pilot-evidence.json",
    evidenceKeys: Object.freeze(["shopCount"]),
    maximumAgeMs: 30 * 24 * 60 * 60_000,
    mode: "pilot_evidence",
    timestampField: "completedAt",
  }),
  quality: Object.freeze({
    artifactFile: "quality-evidence.json",
    evidenceKeys: Object.freeze([
      "auditHigh",
      "build",
      "buildStaging",
      "check",
      "deployDryRun",
      "deployStagingDryRun",
      "gitDiffCheck",
      "lint",
      "schemaVersion",
      "test",
      "tscNoEmit",
    ]),
    maximumAgeMs: 30 * 24 * 60 * 60_000,
    mode: "quality_evidence",
    timestampField: "observedAt",
  }),
});
const MAX_SMOKE_RESPONSE_BYTES = 256 * 1024;

function getPath(value, path) {
  return path.split(".").reduce((current, key) => (
    typeof current === "object" && current !== null ? current[key] : undefined
  ), value);
}

function isConfigured(value) {
  if (typeof value === "boolean" || typeof value === "number") return true;
  return typeof value === "string" && value.trim().length > 0 && !PLACEHOLDER_PATTERN.test(value);
}

function makeCheck(name, ok) {
  return { name, ok: Boolean(ok) };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function validateSourceMigrationNames(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("source_migration_ledger_invalid");
  }
  const names = [...value].sort();
  if (names.some((name, index) => {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/u.exec(name);
    return match === null || Number(match[1]) !== index + 1;
  })) {
    throw new Error("source_migration_ledger_invalid");
  }
  return names;
}

function listMigrationNamesSync(root = repositoryRoot) {
  return validateSourceMigrationNames(
    readdirSync(resolve(root, "migrations")).filter((name) => name.endsWith(".sql")),
  );
}

function bindingNames(items) {
  return new Set(Array.isArray(items) ? items.map((item) => item?.binding).filter((name) => typeof name === "string") : []);
}

function queueNames(config) {
  const producers = bindingNames(config?.queues?.producers);
  const consumers = new Set(Array.isArray(config?.queues?.consumers)
    ? config.queues.consumers.map((item) => item?.queue).filter((name) => typeof name === "string")
    : []);
  return { consumers, producers };
}

function safeDate(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validHostname(value) {
  return typeof value === "string"
    && value.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u.test(value);
}

function validHttpsOrigin(value) {
  try {
    const url = new globalThis.URL(value);
    return url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isSafeReleaseArtifactReference(value, releaseId) {
  return typeof value === "string"
    && PRIVATE_RELEASE_ARTIFACT_REF_PATTERN.test(value)
    && value.startsWith(`.wrangler/releases/${releaseId}/`)
    && !value.includes("..")
    && !value.includes("\\");
}

function readPrivateReleaseArtifactSync(root, reference) {
  if (typeof reference !== "string") return null;
  if (!isSafeReleaseArtifactReference(reference, reference.split("/")[2] ?? "")) return null;
  const artifactPath = resolve(root, reference);
  let stat;
  try {
    stat = lstatSync(artifactPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) return null;
  try {
    const bytes = readFileSync(artifactPath);
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return null;
  }
}

function expectedLegalSupportArtifactRef(releaseId) {
  return `.wrangler/releases/${releaseId}/legal-support-decisions.json`;
}

/**
 * Validate the owner-approved legal/support checklist without storing legal
 * values in release evidence. The artifact is reference-only and mode 0600.
 */
export function validateLegalSupportDecisionEvidence({ evidence, now = new Date(), repositoryRoot: root = repositoryRoot } = {}) {
  const entry = evidence?.legalSupport;
  const checks = [
    makeCheck("evidence.legalSupport.accepted", entry?.accepted === true),
    makeCheck("evidence.legalSupport.evidenceRef", isSafeReleaseArtifactReference(entry?.evidenceRef, evidence?.releaseId)),
    makeCheck("evidence.legalSupport.artifactSha256", typeof entry?.artifactSha256 === "string" && SHA256_PATTERN.test(entry.artifactSha256)),
    makeCheck("evidence.legalSupport.artifactSchemaVersion", entry?.artifactSchemaVersion === 1),
    makeCheck("evidence.legalSupport.observedAt", safeDate(entry?.observedAt) !== null),
    makeCheck(
      "evidence.legalSupport.requiredDecisionKeys",
      Array.isArray(entry?.requiredDecisionKeys)
        && isDeepStrictEqual([...entry.requiredDecisionKeys].sort(), [...REQUIRED_LEGAL_SUPPORT_DECISION_KEYS].sort()),
    ),
  ];
  const expectedRef = expectedLegalSupportArtifactRef(evidence?.releaseId ?? "");
  checks.push(makeCheck("evidence.legalSupport.canonicalRef", entry?.evidenceRef === expectedRef));

  const observedAt = safeDate(entry?.observedAt);
  checks.push(makeCheck(
    "evidence.legalSupport.observedAtFresh",
    observedAt !== null && observedAt <= now.getTime() && now.getTime() - observedAt <= 30 * 24 * 60 * 60_000,
  ));

  const loaded = entry?.evidenceRef === expectedRef
    ? readPrivateReleaseArtifactSync(root, entry.evidenceRef)
    : null;
  checks.push(makeCheck("evidence.legalSupport.artifactPresent", loaded !== null));
  checks.push(makeCheck("evidence.legalSupport.artifactMode", loaded?.value?.mode === LEGAL_SUPPORT_ARTIFACT_MODE));
  checks.push(makeCheck("evidence.legalSupport.artifactHash", loaded !== null
    && typeof entry?.artifactSha256 === "string"
    && createHash("sha256").update(loaded.bytes).digest("hex") === entry.artifactSha256));

  const artifact = loaded?.value;
  const artifactKeys = artifact && typeof artifact === "object" && !Array.isArray(artifact)
    ? Object.keys(artifact).sort()
    : [];
  const expectedArtifactKeys = ["commitSha", "decisions", "environment", "mode", "observedAt", "releaseId", "schemaVersion", "treeSha"];
  checks.push(makeCheck("evidence.legalSupport.artifactSchema", artifact?.schemaVersion === 1
    && isDeepStrictEqual(artifactKeys, expectedArtifactKeys)));
  checks.push(makeCheck("evidence.legalSupport.artifactBinding", artifact?.environment === "production"
    && artifact?.releaseId === evidence?.releaseId
    && artifact?.commitSha === evidence?.commitSha
    && artifact?.treeSha === evidence?.treeSha
    && artifact?.observedAt === entry?.observedAt));

  const decisions = artifact?.decisions;
  const decisionKeys = decisions && typeof decisions === "object" && !Array.isArray(decisions)
    ? Object.keys(decisions).sort()
    : [];
  const decisionsShape = isDeepStrictEqual(decisionKeys, [...REQUIRED_LEGAL_SUPPORT_DECISION_KEYS].sort())
    && REQUIRED_LEGAL_SUPPORT_DECISION_KEYS.every((key) => {
      const decision = decisions?.[key];
      if (!decision || typeof decision !== "object" || Array.isArray(decision)) return false;
      const keys = Object.keys(decision).sort();
      return isDeepStrictEqual(keys, ["effectiveAt", "evidenceRef", "ownerRef", "status"])
        && decision.status === "approved"
        && PRIVATE_EVIDENCE_REF_PATTERN.test(decision.ownerRef)
        && PRIVATE_EVIDENCE_REF_PATTERN.test(decision.evidenceRef)
        && safeDate(decision.effectiveAt) !== null
        && safeDate(decision.effectiveAt) <= now.getTime();
    });
  checks.push(makeCheck("evidence.legalSupport.decisions", decisionsShape));

  return {
    checks,
    missing: checks.filter((check) => !check.ok).map((check) => check.name),
    ok: checks.every((check) => check.ok),
  };
}

export function validateSecretInventoryEvidence({ evidence, workerSecretNames, repositoryRoot: root = repositoryRoot } = {}) {
  const inventory = evidence?.secretInventory;
  const expectedNames = [...REQUIRED_WORKER_SECRET_NAMES].sort();
  const actualNames = Array.isArray(inventory?.requiredNames) ? [...inventory.requiredNames].sort() : [];
  const observedNames = Array.isArray(workerSecretNames) ? [...new Set(workerSecretNames)].sort() : [];
  const validNameSet = (names) => names.length > 0
    && new Set(names).size === names.length
    && names.every((name) => typeof name === "string" && /^[A-Z][A-Z0-9_]{1,127}$/u.test(name));
  const includesRequiredNames = (names) => validNameSet(names)
    && expectedNames.every((name) => names.includes(name));
  const expectedRef = `.wrangler/releases/${evidence?.releaseId ?? ""}/production-secret-inventory.json`;
  const inventoryKeys = inventory && typeof inventory === "object" && !Array.isArray(inventory)
    ? Object.keys(inventory).sort()
    : [];
  const checks = [
    makeCheck("evidence.secretInventory.schema", isDeepStrictEqual(inventoryKeys, ["artifactSha256", "evidenceRef", "mode", "requiredNames", "schemaVersion"])),
    makeCheck("evidence.secretInventory.schemaVersion", inventory?.schemaVersion === REQUIRED_SECRET_INVENTORY_SCHEMA_VERSION),
    makeCheck("evidence.secretInventory.mode", inventory?.mode === "name_only"),
    makeCheck("evidence.secretInventory.evidenceRef", inventory?.evidenceRef === expectedRef
      && isSafeReleaseArtifactReference(inventory.evidenceRef, evidence?.releaseId)),
    makeCheck("evidence.secretInventory.artifactSha256", typeof inventory?.artifactSha256 === "string" && SHA256_PATTERN.test(inventory.artifactSha256)),
    makeCheck("evidence.secretInventory.requiredNames", includesRequiredNames(actualNames)),
    makeCheck("evidence.secretInventory.matchesWorker", includesRequiredNames(observedNames)),
  ];
  const loaded = inventory?.evidenceRef === expectedRef
    ? readPrivateReleaseArtifactSync(root, inventory.evidenceRef)
    : null;
  checks.push(makeCheck("evidence.secretInventory.artifactPresent", loaded !== null));
  checks.push(makeCheck("evidence.secretInventory.artifactHash", loaded !== null
    && typeof inventory?.artifactSha256 === "string"
    && createHash("sha256").update(loaded.bytes).digest("hex") === inventory.artifactSha256));
  const artifact = loaded?.value;
  const artifactKeys = artifact && typeof artifact === "object" && !Array.isArray(artifact)
    ? Object.keys(artifact).sort()
    : [];
  checks.push(makeCheck("evidence.secretInventory.artifactSchema", artifact?.schemaVersion === REQUIRED_SECRET_INVENTORY_SCHEMA_VERSION
    && isDeepStrictEqual(artifactKeys, ["commitSha", "environment", "mode", "releaseId", "schemaVersion", "secretNames", "treeSha"])));
  checks.push(makeCheck("evidence.secretInventory.artifactBinding", artifact?.environment === "production"
    && artifact?.mode === "name_only"
    && artifact?.releaseId === evidence?.releaseId
    && artifact?.commitSha === evidence?.commitSha
    && artifact?.treeSha === evidence?.treeSha));
  const artifactNames = Array.isArray(artifact?.secretNames) ? [...artifact.secretNames].sort() : [];
  checks.push(makeCheck("evidence.secretInventory.artifactNames", includesRequiredNames(artifactNames)));
  checks.push(makeCheck("evidence.secretInventory.namesMatchEvidence", isDeepStrictEqual(artifactNames, actualNames)));
  checks.push(makeCheck("evidence.secretInventory.namesMatchWorker", isDeepStrictEqual(artifactNames, observedNames)));
  return {
    checks,
    missing: checks.filter((check) => !check.ok).map((check) => check.name),
    ok: checks.every((check) => check.ok),
  };
}

function candidateBoundEvidenceRef(releaseId, definition) {
  return `.wrangler/releases/${releaseId}/${definition.artifactFile}`;
}

function candidateBoundEvidenceArtifactKeys() {
  return [
    "commitSha",
    "environment",
    "evidence",
    "mode",
    "observedAt",
    "releaseId",
    "schemaVersion",
    "treeSha",
    "workerVersion",
  ];
}

function candidateBoundEvidenceWorkerVersion(evidence, section) {
  return section === "quality"
    ? evidence?.staging?.workerVersion
    : evidence?.candidateWorkerVersion;
}

/**
 * Require operational evidence to be a private, candidate-bound artifact.
 * Root booleans remain useful projections, but never authorize admission by
 * themselves when the strict release gate is enabled.
 */
export function validateCandidateBoundReleaseEvidence({ evidence, now = new Date(), repositoryRoot: root = repositoryRoot } = {}) {
  const results = Object.entries(CANDIDATE_BOUND_EVIDENCE_DEFINITIONS).map(([section, definition]) => {
    const entry = evidence?.[section];
    const timestamp = safeDate(entry?.[definition.timestampField]);
    const expectedRef = candidateBoundEvidenceRef(evidence?.releaseId ?? "", definition);
    const rootChecks = [
      makeCheck(`evidence.${section}.artifactSchemaVersion`, entry?.artifactSchemaVersion === CANDIDATE_BOUND_EVIDENCE_SCHEMA_VERSION),
      makeCheck(`evidence.${section}.artifactSha256`, typeof entry?.artifactSha256 === "string" && SHA256_PATTERN.test(entry.artifactSha256)),
      makeCheck(`evidence.${section}.evidenceRef`, entry?.evidenceRef === expectedRef
        && isSafeReleaseArtifactReference(entry.evidenceRef, evidence?.releaseId)),
      makeCheck(`evidence.${section}.observedAt`, timestamp !== null),
      makeCheck(
        `evidence.${section}.observedAtFresh`,
        timestamp !== null && timestamp <= now.getTime() && now.getTime() - timestamp <= definition.maximumAgeMs,
      ),
    ];
    const loaded = entry?.evidenceRef === expectedRef
      ? readPrivateReleaseArtifactSync(root, entry.evidenceRef)
      : null;
    const artifact = loaded?.value;
    const artifactKeys = artifact && typeof artifact === "object" && !Array.isArray(artifact)
      ? Object.keys(artifact).sort()
      : [];
    const expectedArtifactKeys = [...candidateBoundEvidenceArtifactKeys()].sort();
    const expectedEvidence = Object.fromEntries(definition.evidenceKeys.map((key) => [key, entry?.[key]]));
    const expectedWorkerVersion = candidateBoundEvidenceWorkerVersion(evidence, section);
    const artifactEvidence = artifact?.evidence;
    const artifactEvidenceKeys = artifactEvidence && typeof artifactEvidence === "object" && !Array.isArray(artifactEvidence)
      ? Object.keys(artifactEvidence).sort()
      : [];
    const checks = [
      ...rootChecks,
      makeCheck(`evidence.${section}.artifactPresent`, loaded !== null),
      makeCheck(`evidence.${section}.artifactMode`, artifact?.mode === definition.mode),
      makeCheck(`evidence.${section}.artifactHash`, loaded !== null
        && typeof entry?.artifactSha256 === "string"
        && createHash("sha256").update(loaded.bytes).digest("hex") === entry.artifactSha256),
      makeCheck(`evidence.${section}.artifactSchema`, artifact?.schemaVersion === CANDIDATE_BOUND_EVIDENCE_SCHEMA_VERSION
        && isDeepStrictEqual(artifactKeys, expectedArtifactKeys)
        && isDeepStrictEqual(artifactEvidenceKeys, [...definition.evidenceKeys].sort())),
      makeCheck(`evidence.${section}.artifactBinding`, artifact?.environment === "production"
        && artifact?.releaseId === evidence?.releaseId
        && artifact?.commitSha === evidence?.commitSha
        && artifact?.treeSha === evidence?.treeSha
        && artifact?.workerVersion === expectedWorkerVersion
        && artifact?.observedAt === entry?.[definition.timestampField]),
      makeCheck(`evidence.${section}.artifactEvidence`, isDeepStrictEqual(artifactEvidence, expectedEvidence)),
    ];
    return {
      checks,
      missing: checks.filter((check) => !check.ok).map((check) => check.name),
      ok: checks.every((check) => check.ok),
      ref: typeof entry?.evidenceRef === "string" ? entry.evidenceRef : null,
    };
  });
  const refs = results.map((result) => result.ref).filter((ref) => typeof ref === "string");
  const uniqueCheck = makeCheck("evidence.candidateBoundArtifacts.uniqueRefs", new Set(refs).size === refs.length);
  const checks = [...results.flatMap((result) => result.checks), uniqueCheck];
  return {
    checks,
    missing: checks.filter((check) => !check.ok).map((check) => check.name),
    ok: checks.every((check) => check.ok),
  };
}

function projectCandidateBoundReleaseEvidence(evidence) {
  return Object.fromEntries(Object.keys(CANDIDATE_BOUND_EVIDENCE_DEFINITIONS).map((section) => {
    const entry = evidence?.[section] ?? {};
    return [section, {
      artifactSchemaVersion: entry.artifactSchemaVersion,
      artifactSha256: entry.artifactSha256,
      evidenceRef: entry.evidenceRef,
      observedAt: entry[CANDIDATE_BOUND_EVIDENCE_DEFINITIONS[section].timestampField],
    }];
  }));
}

function validProductionVar(name, value) {
  if (name === "APP_ENV") return value === "production";
  if (name === "CANARY_HOSTNAME") return validHostname(value) && value === "canary.selinow.com";
  if (name === "CLOUDFLARE_ZONE_ID") return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
  if (["API_ORIGIN", "DASHBOARD_ORIGIN", "MEDIA_PUBLIC_BASE_URL", "PLATFORM_ORIGIN"].includes(name)) return validHttpsOrigin(value);
  if (name === "PLATFORM_BASE_DOMAIN" || name === "SAAS_CNAME_TARGET") return validHostname(value);
  if (name === "RESOURCE_MANIFEST_VERSION") return typeof value === "string" && /^[a-f0-9]{16,64}$/u.test(value);
  if (name === "SESSION_COOKIE_NAME") return value === "selinow_session";
  return isConfigured(value);
}

function validSpecPath(path, value) {
  if (path === "environment") return value === "production";
  if (path === "accountId" || path === "zoneId") return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
  if (path.startsWith("hostnames.") || path === "zoneName" || path.startsWith("saas.")) return validHostname(value);
  if (path === "workerName") return value === "selinow-com-production";
  if (path.startsWith("resources.")) return typeof value === "string" && /^selinow-(?:[a-z0-9-]+-)?production$/u.test(value);
  return isConfigured(value);
}

function validEvidencePath(path, value) {
  if (path.startsWith("approvals.")) {
    return typeof value === "string"
      && value.trim().length > 0
      && !PLACEHOLDER_PATTERN.test(value)
      && !/^(?:pending|tbd|todo|unapproved|unknown)$/iu.test(value.trim());
  }
  if (path.endsWith(".evidenceRef")) return isConfigured(value);
  if (path === "manualAcceptance.observedAt" || path === "monitoring.observedAt" || path === "pilot.completedAt" || path === "rollback.rehearsedAt") {
    return safeDate(value) !== null;
  }
  if (path === "quality.schemaVersion") return value === 2;
  if (path.startsWith("quality.") || path.startsWith("manualAcceptance.") || path.startsWith("monitoring.")) return value === true;
  if (path === "staging.accepted") return value === true;
  if (path === "staging.acceptedAt") return safeDate(value) !== null;
  if (path === "staging.releaseId") return typeof value === "string" && /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u.test(value);
  if (path === "staging.manifestRef") return typeof value === "string" && /^\.wrangler\/releases\/staging\/stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}\/release-manifest\.json$/u.test(value);
  if (path === "staging.manifestSha256") return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
  if (path === "staging.workerVersion") return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(value) && !PLACEHOLDER_PATTERN.test(value);
  if (path === "candidateWorkerVersion" || path === "previousWorkerVersion") {
    return typeof value === "string"
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
  }
  if (/^providerAcceptance\.[a-zA-Z][a-zA-Z0-9]*\.accepted$/u.test(path)) return value === true;
  if (/^providerAcceptance\.[a-zA-Z][a-zA-Z0-9]*\.observedAt$/u.test(path)) return safeDate(value) !== null;
  if (/^commerceAcceptance\.[a-zA-Z][a-zA-Z0-9]*\.accepted$/u.test(path)) return value === true;
  if (/^commerceAcceptance\.[a-zA-Z][a-zA-Z0-9]*\.observedAt$/u.test(path)) return safeDate(value) !== null;
  if (path === "security.criticalOpen" || path === "security.highOpen") return value === 0;
  if (path === "pilot.shopCount") return Number.isSafeInteger(value) && value >= 2;
  if (path === "releaseId") return typeof value === "string" && RELEASE_ID_PATTERN.test(value) && !PLACEHOLDER_PATTERN.test(value);
  if (path === "commitSha" || path === "treeSha") return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
  return isConfigured(value);
}

function evaluateReleaseScope(evidence) {
  const activeChannels = Array.isArray(evidence?.releaseScope?.activeChannels)
    ? evidence.releaseScope.activeChannels
    : [];
  const deferredChannels = Array.isArray(evidence?.releaseScope?.deferredChannels)
    ? evidence.releaseScope.deferredChannels
    : [];
  const knownChannels = new Set(RELEASE_CHANNEL_KEYS);
  const activeProviderKeys = activeChannels.filter((channel) => channel !== "website");
  const deferredProviderKeys = deferredChannels.filter((channel) => channel !== "website");
  const activeValid = activeChannels.every((channel) => typeof channel === "string" && knownChannels.has(channel));
  const deferredValid = deferredChannels.every((channel) => typeof channel === "string" && knownChannels.has(channel));
  const activeUnique = new Set(activeChannels).size === activeChannels.length;
  const deferredUnique = new Set(deferredChannels).size === deferredChannels.length;
  const uniqueChannels = new Set([...activeChannels, ...deferredChannels]);
  const complete = activeUnique
    && deferredUnique
    && uniqueChannels.size === RELEASE_CHANNEL_KEYS.length
    && RELEASE_CHANNEL_KEYS.every((channel) => uniqueChannels.has(channel))
    && activeChannels.every((channel) => !deferredChannels.includes(channel));
  const coreLaunch = activeChannels.includes("website") && activeChannels.includes("telegramBot");
  const deferredAccepted = deferredChannels.some((channel) => evidence?.providerAcceptance?.[channel]?.accepted === true);
  return {
    activeProviderKeys,
    deferredProviderKeys,
    checks: [
      makeCheck("evidence.schemaVersion", evidence?.schemaVersion === 2),
      makeCheck("evidence.environment", evidence?.environment === "production"),
      makeCheck("evidence.releaseScope.activeChannels", activeChannels.length > 0 && activeValid),
      makeCheck("evidence.releaseScope.deferredChannels", deferredValid),
      makeCheck("evidence.releaseScope.channelsComplete", complete),
      makeCheck("evidence.releaseScope.coreLaunch", coreLaunch),
      makeCheck("evidence.releaseScope.deferredProvidersNotAccepted", !deferredAccepted),
    ],
  };
}

export function evaluateCommerceAcceptance(evidence, artifactValidation, requireArtifactHash = false) {
  return REQUIRED_COMMERCE_ACCEPTANCE_KEYS.flatMap((provider) => [
    makeCheck(
      `evidence.commerceAcceptance.${provider}.accepted`,
      validEvidencePath(`commerceAcceptance.${provider}.accepted`, evidence?.commerceAcceptance?.[provider]?.accepted),
    ),
    makeCheck(
      `evidence.commerceAcceptance.${provider}.evidenceRef`,
      validEvidencePath(`commerceAcceptance.${provider}.evidenceRef`, evidence?.commerceAcceptance?.[provider]?.evidenceRef),
    ),
    makeCheck(
      `evidence.commerceAcceptance.${provider}.observedAt`,
      validEvidencePath(`commerceAcceptance.${provider}.observedAt`, evidence?.commerceAcceptance?.[provider]?.observedAt),
    ),
    ...((requireArtifactHash || evidence?.commerceAcceptance?.[provider]?.artifactSha256 !== undefined) ? [
      makeCheck(
        `evidence.commerceAcceptance.${provider}.artifactSha256`,
        typeof evidence?.commerceAcceptance?.[provider]?.artifactSha256 === "string"
          && SHA256_PATTERN.test(evidence.commerceAcceptance[provider].artifactSha256),
      ),
    ] : []),
    ...(artifactValidation === undefined && !requireArtifactHash ? [] : [
      makeCheck(`evidence.commerceAcceptance.${provider}.artifactRefCanonical`, typeof evidence?.commerceAcceptance?.[provider]?.evidenceRef === "string"
        && evidence.commerceAcceptance[provider].evidenceRef.startsWith(".wrangler/releases/staging/")),
      makeCheck(`evidence.commerceAcceptance.${provider}.artifactAccepted`, artifactValidation?.[provider]?.accepted === true),
      makeCheck(`evidence.commerceAcceptance.${provider}.artifactFingerprintSha256`, typeof artifactValidation?.[provider]?.artifactFingerprintSha256 === "string" && SHA256_PATTERN.test(artifactValidation[provider].artifactFingerprintSha256)),
      makeCheck(`evidence.commerceAcceptance.${provider}.artifactSha256Binding`, artifactValidation?.[provider]?.artifactFingerprintSha256 === evidence?.commerceAcceptance?.[provider]?.artifactSha256),
      makeCheck(`evidence.commerceAcceptance.${provider}.artifactReleaseBinding`, artifactValidation?.[provider]?.releaseId === evidence?.staging?.releaseId
        && artifactValidation?.[provider]?.manifestRef === evidence?.staging?.manifestRef
        && artifactValidation?.[provider]?.manifestSha256 === evidence?.staging?.manifestSha256
        && artifactValidation?.[provider]?.workerVersion === evidence?.staging?.workerVersion),
    ]),
  ]);
}

function acceptanceEntry(source, key) {
  const entry = source?.[key] ?? {};
  return {
    accepted: entry.accepted === true,
    ...(typeof entry.artifactSha256 === "string" ? { artifactSha256: entry.artifactSha256 } : {}),
    evidenceRef: typeof entry.evidenceRef === "string" ? entry.evidenceRef : null,
    observedAt: typeof entry.observedAt === "string" ? entry.observedAt : null,
  };
}

function projectAcceptance(source, keys, artifactValidation) {
  return Object.fromEntries(keys.map((key) => {
    const entry = acceptanceEntry(source, key);
    const validation = artifactValidation?.[key];
    if (validation?.accepted !== true) return [key, entry];
    return [key, {
      ...entry,
      artifactFingerprintSha256: validation.artifactFingerprintSha256,
      artifactReleaseId: validation.releaseId,
      artifactManifestRef: validation.manifestRef,
      artifactManifestSha256: validation.manifestSha256,
      artifactWorkerVersion: validation.workerVersion,
      artifactScenarioCount: validation.scenarioCount,
      ...(typeof validation.paymentLaneAccepted === "boolean" ? { paymentLaneAccepted: validation.paymentLaneAccepted } : {}),
      ...(typeof validation.fullCommerceAccepted === "boolean" ? { fullCommerceAccepted: validation.fullCommerceAccepted } : {}),
      ...(Array.isArray(validation.reasonCodes) ? { reasonCodes: [...validation.reasonCodes] } : {}),
    }];
  }));
}

export function evaluateBackupPrerequisites(evidence, now = new Date()) {
  const backup = evidence?.backup;
  const completedAt = safeDate(backup?.completedAt);
  const restoreCompletedAt = safeDate(backup?.restoreDrillCompletedAt);
  const age = completedAt === null ? Number.POSITIVE_INFINITY : now.getTime() - completedAt;
  const restoreAge = restoreCompletedAt === null ? Number.POSITIVE_INFINITY : now.getTime() - restoreCompletedAt;
  return [
    makeCheck("backup.snapshotReportRef", isConfigured(backup?.snapshotReportRef)),
    makeCheck("backup.providerBookmarkRecorded", backup?.providerBookmarkRecorded === true),
    makeCheck("backup.completedAt", completedAt !== null && age >= 0 && age <= 24 * 60 * 60_000),
    makeCheck("backup.restoreDrillReportRef", isConfigured(backup?.restoreDrillReportRef)),
    makeCheck("backup.restoreDrillPassed", backup?.restoreDrillPassed === true),
    makeCheck("backup.restoreDrillCompletedAt", restoreCompletedAt !== null && restoreAge >= 0 && restoreAge <= 30 * 24 * 60 * 60_000),
  ];
}

export function evaluateProductionRollbackCandidate(evidence, now = new Date(), migrationNames = []) {
  const candidate = evidence?.rollback?.candidate ?? {};
  let sourceMigrationNames = [];
  try {
    sourceMigrationNames = validateSourceMigrationNames(migrationNames);
  } catch {
    // The failed ledger check below keeps readiness fail-closed.
  }
  const expectedMigrationName = sourceMigrationNames.at(-1);
  const expectedMigrationLedgerSha256 = sourceMigrationNames.length > 0
    ? fingerprint(sourceMigrationNames)
    : null;
  const rehearsedAt = safeDate(candidate.rehearsedAt);
  const rehearsalFresh = rehearsedAt !== null
    && rehearsedAt <= now.getTime()
    && now.getTime() - rehearsedAt <= 30 * 24 * 60 * 60_000;
  const workerVersionValid = typeof candidate.workerVersion === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(candidate.workerVersion);
  const invariants = Array.isArray(candidate.invariants) ? candidate.invariants : [];
  const invariantsValid = invariants.length >= REQUIRED_PRODUCTION_ROLLBACK_INVARIANTS.length
    && new Set(invariants).size === invariants.length
    && invariants.every((name) => typeof name === "string" && /^[a-z][a-z0-9_]{2,127}$/u.test(name))
    && REQUIRED_PRODUCTION_ROLLBACK_INVARIANTS.every((name) => invariants.includes(name));
  const checks = [
    makeCheck("evidence.rollback.candidate.accepted", candidate.accepted === true),
    makeCheck("evidence.rollback.candidate.artifactSha256", typeof candidate.artifactSha256 === "string" && /^[a-f0-9]{64}$/u.test(candidate.artifactSha256)),
    makeCheck("evidence.rollback.candidate.commitSha", typeof candidate.commitSha === "string" && /^[a-f0-9]{40}$/u.test(candidate.commitSha)),
    makeCheck("evidence.rollback.candidate.evidenceRef", isConfigured(candidate.evidenceRef)),
    makeCheck("evidence.rollback.candidate.invariants", invariantsValid),
    makeCheck("evidence.rollback.candidate.migrationLedger", expectedMigrationName !== undefined),
    makeCheck("evidence.rollback.candidate.migrationLedgerSha256", expectedMigrationLedgerSha256 !== null && candidate.migrationLedgerSha256 === expectedMigrationLedgerSha256),
    makeCheck("evidence.rollback.candidate.migrationName", expectedMigrationName !== undefined && candidate.migrationName === expectedMigrationName),
    makeCheck("evidence.rollback.candidate.rehearsalPassed", candidate.rehearsalPassed === true),
    makeCheck("evidence.rollback.candidate.rehearsedAt", rehearsedAt !== null && candidate.rehearsedAt === evidence?.rollback?.rehearsedAt),
    makeCheck("evidence.rollback.candidate.rehearsedAtFresh", rehearsalFresh),
    makeCheck("evidence.rollback.candidate.schemaVersion", candidate.schemaVersion === 2),
    makeCheck("evidence.rollback.candidate.treeSha", typeof candidate.treeSha === "string" && /^[a-f0-9]{40}$/u.test(candidate.treeSha)),
    makeCheck("evidence.rollback.candidate.workerVersion", workerVersionValid),
    makeCheck("evidence.rollback.candidate.notCurrentWorker", workerVersionValid && candidate.workerVersion !== evidence?.previousWorkerVersion),
    makeCheck("evidence.rollback.candidate.distinctFromReleaseCandidate", workerVersionValid && candidate.workerVersion !== evidence?.candidateWorkerVersion),
    makeCheck("evidence.rollback.candidate.commitDistinctFromReleaseCandidate", candidate.commitSha !== evidence?.commitSha),
  ];
  return {
    candidate: {
      accepted: candidate.accepted === true,
      artifactSha256: candidate.artifactSha256,
      commitSha: candidate.commitSha,
      evidenceRef: candidate.evidenceRef,
      invariants: [...invariants],
      migrationLedgerSha256: candidate.migrationLedgerSha256,
      migrationName: candidate.migrationName,
      rehearsalPassed: candidate.rehearsalPassed === true,
      rehearsedAt: candidate.rehearsedAt,
      schemaVersion: candidate.schemaVersion,
      treeSha: candidate.treeSha,
      workerVersion: candidate.workerVersion,
    },
    checks,
    missing: checks.filter((check) => !check.ok).map((check) => check.name),
    ok: checks.every((check) => check.ok),
  };
}

export function inspectProductionReadiness(input) {
  const production = input.wranglerConfig?.env?.production;
  const spec = input.productionSpec;
  const evidence = input.evidence;
  const requiresReleaseHardening = input.requireReleaseHardening === true
    || evidence?.legalSupport !== undefined
    || evidence?.secretInventory !== undefined;
  let migrationNames = [];
  try {
    migrationNames = input.migrationNames === undefined
      ? listMigrationNamesSync(input.repositoryRoot ?? repositoryRoot)
      : validateSourceMigrationNames(input.migrationNames);
  } catch {
    // Rollback admission reports the invalid source ledger as a missing check.
  }
  // Live-observed provider validation is injected by async release entrypoints.
  const commerceEvidenceValidation = input.commerceEvidenceValidation;
  const releaseScope = evaluateReleaseScope(evidence);
  const rollbackCandidate = evaluateProductionRollbackCandidate(evidence, input.now, migrationNames);
  const checks = [
    makeCheck("wrangler.env.production", typeof production === "object" && production !== null),
    makeCheck("wrangler.env.production.name", isConfigured(production?.name)),
    makeCheck("wrangler.env.production.workers_dev", production?.workers_dev === false),
    makeCheck("wrangler.env.production.preview_urls", production?.preview_urls === false),
    makeCheck("wrangler.env.production.routes", Array.isArray(production?.routes) && production.routes.length >= 3),
    makeCheck("wrangler.env.production.assets.ASSETS", production?.assets?.binding === "ASSETS"),
  ];

  const d1Bindings = bindingNames(production?.d1_databases);
  const r2Bindings = bindingNames(production?.r2_buckets);
  const kvBindings = bindingNames(production?.kv_namespaces);
  const emailBindings = new Map(
    Array.isArray(production?.send_email)
      ? production.send_email
        .filter((binding) => typeof binding?.name === "string")
        .map((binding) => [binding.name, binding])
      : [],
  );
  const queues = queueNames(production);
  checks.push(
    makeCheck("binding.PLATFORM_DB", d1Bindings.has("PLATFORM_DB")),
    makeCheck("binding.MEDIA", r2Bindings.has("MEDIA")),
    makeCheck("binding.PRIVATE_EXPORTS", r2Bindings.has("PRIVATE_EXPORTS")),
    makeCheck("binding.PLATFORM_CACHE", kvBindings.has("PLATFORM_CACHE")),
    makeCheck("binding.SESSION", kvBindings.has("SESSION")),
    makeCheck("binding.EMAIL", emailBindings.has("EMAIL")),
    makeCheck(
      "binding.EMAIL.allowedSender",
      Array.isArray(emailBindings.get("EMAIL")?.allowed_sender_addresses)
        && emailBindings.get("EMAIL").allowed_sender_addresses.includes(production?.vars?.EMAIL_FROM_ADDRESS),
    ),
    makeCheck("binding.INTEGRATION_QUEUE", queues.producers.has("INTEGRATION_QUEUE")),
    makeCheck("binding.NOTIFICATION_QUEUE", queues.producers.has("NOTIFICATION_QUEUE")),
    makeCheck("queue.consumer.integration", isConfigured(spec?.resources?.integrationQueue) && queues.consumers.has(spec.resources.integrationQueue)),
    makeCheck("queue.consumer.notification", isConfigured(spec?.resources?.notificationQueue) && queues.consumers.has(spec.resources.notificationQueue)),
    makeCheck("queue.consumer.deadLetter", isConfigured(spec?.resources?.deadLetterQueue) && queues.consumers.has(spec.resources.deadLetterQueue)),
    makeCheck("wrangler.env.production.triggers", isDeepStrictEqual(production?.triggers?.crons, ["*/15 * * * *"])),
    makeCheck("wrangler.env.production.observability", production?.observability?.enabled === true),
  );
  const activeRefs = releaseScope.activeProviderKeys
    .map((provider) => evidence?.providerAcceptance?.[provider]?.evidenceRef)
    .filter((value) => typeof value === "string");
  const commerceRefs = REQUIRED_COMMERCE_ACCEPTANCE_KEYS
    .map((provider) => evidence?.commerceAcceptance?.[provider]?.evidenceRef)
    .filter((value) => typeof value === "string");
  checks.push(
    makeCheck("evidence.providerAcceptance.activeEvidenceRefsUnique", new Set(activeRefs).size === activeRefs.length),
    makeCheck("evidence.commerceAcceptance.evidenceRefsUnique", new Set(commerceRefs).size === commerceRefs.length),
    makeCheck("evidence.acceptanceRefs.crossLaneUnique", new Set([...activeRefs, ...commerceRefs]).size === activeRefs.length + commerceRefs.length),
  );
  if (requiresReleaseHardening) {
    const legalRef = evidence?.legalSupport?.evidenceRef;
    const secretInventoryRef = evidence?.secretInventory?.evidenceRef;
    const candidateBoundRefs = Object.keys(CANDIDATE_BOUND_EVIDENCE_DEFINITIONS)
      .map((section) => evidence?.[section]?.evidenceRef)
      .filter((value) => typeof value === "string");
    const allArtifactRefs = [
      ...activeRefs,
      ...commerceRefs,
      ...(typeof legalRef === "string" ? [legalRef] : []),
      ...(typeof secretInventoryRef === "string" ? [secretInventoryRef] : []),
      ...candidateBoundRefs,
    ];
    checks.push(makeCheck(
      "evidence.acceptanceRefs.legalSupportUnique",
      typeof legalRef !== "string" || !new Set([...activeRefs, ...commerceRefs]).has(legalRef),
    ));
    checks.push(makeCheck(
      "evidence.acceptanceRefs.allArtifactsUnique",
      new Set(allArtifactRefs).size === allArtifactRefs.length,
    ));
  }

  for (const name of REQUIRED_PRODUCTION_VARS) {
    const value = production?.vars?.[name];
    checks.push(makeCheck(`var.${name}`, validProductionVar(name, value)));
  }
  for (const name of REQUIRED_WORKER_SECRET_NAMES) {
    checks.push(makeCheck(`secret.${name}`, input.workerSecretNames?.includes(name) === true));
  }
  for (const path of REQUIRED_SPEC_PATHS) {
    const value = getPath(spec, path);
    checks.push(makeCheck(`productionSpec.${path}`, validSpecPath(path, value)));
  }
  for (const path of REQUIRED_EVIDENCE_PATHS) {
    const value = getPath(evidence, path);
    checks.push(makeCheck(`evidence.${path}`, validEvidencePath(path, value)));
  }
  const routes = new Set(Array.isArray(production?.routes) ? production.routes.map((route) => route?.pattern).filter((value) => typeof value === "string") : []);
  const productionFallback = Array.isArray(production?.routes)
    ? production.routes.find((route) => route?.pattern === "*/*")
    : null;
  const stagingRoutes = input.wranglerConfig?.env?.staging?.routes;
  const d1Database = Array.isArray(production?.d1_databases)
    ? production.d1_databases.find((database) => database?.binding === "PLATFORM_DB")
    : null;
  const mediaBucket = Array.isArray(production?.r2_buckets)
    ? production.r2_buckets.find((bucket) => bucket?.binding === "MEDIA")
    : null;
  const exportsBucket = Array.isArray(production?.r2_buckets)
    ? production.r2_buckets.find((bucket) => bucket?.binding === "PRIVATE_EXPORTS")
    : null;
  checks.push(
    makeCheck("alignment.workerName", isConfigured(spec?.workerName) && production?.name === spec.workerName),
    makeCheck("alignment.resource.d1", isConfigured(spec?.resources?.d1) && d1Database?.database_name === spec.resources.d1),
    makeCheck("alignment.resource.media", isConfigured(spec?.resources?.r2) && mediaBucket?.bucket_name === spec.resources.r2),
    makeCheck("alignment.resource.privateExports", isConfigured(spec?.resources?.privateExports) && exportsBucket?.bucket_name === spec.resources.privateExports),
    makeCheck("alignment.queue.integration", isConfigured(spec?.resources?.integrationQueue) && queues.consumers.has(spec.resources.integrationQueue)),
    makeCheck("alignment.queue.notification", isConfigured(spec?.resources?.notificationQueue) && queues.consumers.has(spec.resources.notificationQueue)),
    makeCheck("alignment.queue.deadLetter", isConfigured(spec?.resources?.deadLetterQueue) && queues.consumers.has(spec.resources.deadLetterQueue)),
    makeCheck("alignment.route.marketing", isConfigured(spec?.hostnames?.marketing)
      && (routes.has(spec.hostnames.marketing) || routes.has(`${spec.hostnames.marketing}/*`))),
    makeCheck("alignment.route.dashboard", isConfigured(spec?.hostnames?.dashboard)
      && (routes.has(spec.hostnames.dashboard) || routes.has(`${spec.hostnames.dashboard}/*`))),
    makeCheck("alignment.route.api", isConfigured(spec?.hostnames?.api)
      && (routes.has(spec.hostnames.api) || routes.has(`${spec.hostnames.api}/*`))),
    makeCheck("alignment.route.externalCustomDomains", productionFallback?.zone_name === spec?.zoneName),
    makeCheck("alignment.route.externalCustomDomainsNotStaging", Array.isArray(stagingRoutes)
      && !stagingRoutes.some((route) => route?.pattern === "*/*")),
    makeCheck("alignment.route.externalCustomDomainStrategy",
      spec?.routing?.externalCustomDomainFallbackRoute === "*/*"
      && spec?.routing?.externalCustomDomainStrategy === "production_fallback_with_platform_staging_exceptions"
      && spec?.routing?.routeHandoff === "atomic_shared_zone_route_replacement"),
    makeCheck("alignment.turnstile.externalCustomDomainAdmission",
      spec?.turnstile?.externalCustomDomainAdmission === "verified_before_domain_activation"
      && spec?.turnstile?.externalCustomDomainStrategy === "exact_hostname_admission_before_activation"),
    makeCheck("alignment.var.zoneId", isConfigured(spec?.zoneId) && production?.vars?.CLOUDFLARE_ZONE_ID === spec.zoneId),
    makeCheck("alignment.var.saasTarget", isConfigured(spec?.saas?.cnameTarget) && production?.vars?.SAAS_CNAME_TARGET === spec.saas.cnameTarget),
  );
  checks.push(...evaluateBackupPrerequisites(evidence, input.now).map((check) => ({
    name: `evidence.${check.name}`,
    ok: check.ok,
  })));
  checks.push(...releaseScope.checks, ...rollbackCandidate.checks, ...evaluateCommerceAcceptance(
    evidence,
    commerceEvidenceValidation,
    requiresReleaseHardening,
  ));
  if (requiresReleaseHardening) {
    checks.push(...validateLegalSupportDecisionEvidence({
      evidence,
      now: input.now,
      repositoryRoot: input.repositoryRoot ?? repositoryRoot,
    }).checks);
    checks.push(...validateSecretInventoryEvidence({
      evidence,
      repositoryRoot: input.repositoryRoot ?? repositoryRoot,
      workerSecretNames: input.workerSecretNames,
    }).checks);
    checks.push(...validateCandidateBoundReleaseEvidence({
      evidence,
      now: input.now,
      repositoryRoot: input.repositoryRoot ?? repositoryRoot,
    }).checks);
  }
  if (commerceEvidenceValidation !== undefined) {
    const dodo = commerceEvidenceValidation.dodo;
    const payos = commerceEvidenceValidation.payos;
    checks.push(makeCheck("evidence.commerceAcceptance.sharedStagingBinding", dodo?.accepted === true
      && payos?.accepted === true
      && dodo.releaseId === payos.releaseId
      && dodo.manifestRef === payos.manifestRef
      && dodo.manifestSha256 === payos.manifestSha256
      && dodo.workerVersion === payos.workerVersion));
  }
  const migrationLedgerPrefix = evidence?.migrationLedgerPrefix;
  checks.push(makeCheck(
    "evidence.migrationLedgerPrefix",
    Array.isArray(migrationLedgerPrefix)
      && migrationLedgerPrefix.length > 0
      && migrationLedgerPrefix.length <= migrationNames.length
      && new Set(migrationLedgerPrefix).size === migrationLedgerPrefix.length
      && migrationLedgerPrefix.every((name, index) => (
        typeof name === "string"
        && /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)
        && name === migrationNames[index]
      )),
  ));
  const now = input.now ?? new Date();
  const recent = (value, maximumAgeMs) => {
    const observedAt = safeDate(value);
    if (observedAt === null || observedAt > now.getTime()) return false;
    return now.getTime() - observedAt <= maximumAgeMs;
  };
  checks.push(
    makeCheck("evidence.manualAcceptance.observedAtFresh", recent(evidence?.manualAcceptance?.observedAt, 30 * 24 * 60 * 60_000)),
    makeCheck("evidence.monitoring.observedAtFresh", recent(evidence?.monitoring?.observedAt, 24 * 60 * 60_000)),
    makeCheck("evidence.pilot.completedAtFresh", recent(evidence?.pilot?.completedAt, 30 * 24 * 60 * 60_000)),
    makeCheck("evidence.rollback.rehearsedAtFresh", recent(evidence?.rollback?.rehearsedAt, 30 * 24 * 60 * 60_000)),
  );
  for (const provider of releaseScope.activeProviderKeys) {
    for (const field of ["accepted", "evidenceRef", "observedAt"]) {
      const path = `providerAcceptance.${provider}.${field}`;
      checks.push(makeCheck(`evidence.${path}`, validEvidencePath(path, getPath(evidence, path))));
    }
  }
  for (const provider of releaseScope.deferredProviderKeys) {
    checks.push(makeCheck(
      `evidence.providerAcceptance.${provider}.deferredNotAccepted`,
      evidence?.providerAcceptance?.[provider]?.accepted !== true,
    ));
  }
  for (const provider of releaseScope.activeProviderKeys) {
    checks.push(makeCheck(
      `evidence.providerAcceptance.${provider}.observedAtFresh`,
      recent(evidence?.providerAcceptance?.[provider]?.observedAt, 30 * 24 * 60 * 60_000),
    ));
  }
  for (const provider of REQUIRED_COMMERCE_ACCEPTANCE_KEYS) {
    checks.push(makeCheck(
      `evidence.commerceAcceptance.${provider}.observedAtFresh`,
      recent(evidence?.commerceAcceptance?.[provider]?.observedAt, 30 * 24 * 60 * 60_000),
    ));
  }

  const unique = new Map(checks.map((check) => [check.name, check]));
  const result = [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
  return {
    checks: result,
    missing: result.filter((check) => !check.ok).map((check) => check.name),
    ok: result.every((check) => check.ok),
  };
}

export function buildRollbackMatrix() {
  return [
    {
      authority: "release_owner",
      containment: "stop_rollout_and_restore_schema_compatible_rollback_candidate",
      signal: "worker_error_or_latency_regression",
      strategy: "schema_compatible_rollback_candidate",
      verification: "health_storefront_dashboard_webhook_smoke",
    },
    {
      authority: "release_owner_and_data_owner",
      containment: "stop_writes_and_new_pilot_traffic",
      signal: "d1_schema_or_data_integrity_regression",
      strategy: "forward_fix_or_restore_to_isolated_database_then_controlled_cutover_no_down_migration",
      verification: "integrity_foreign_keys_counts_and_tenant_isolation",
    },
    {
      authority: "payment_incident_owner",
      containment: "disable_new_checkout_and_pause_fulfillment_workers",
      signal: "payment_or_fulfillment_correctness_failure",
      strategy: "schema_compatible_rollback_candidate_and_manual_payment_exception_review",
      verification: "signed_event_dedupe_inventory_and_fulfillment_reconciliation",
    },
    {
      authority: "integration_incident_owner",
      containment: "pause_affected_integration_jobs_without_rotating_credentials",
      signal: "telegram_or_provider_webhook_degradation",
      strategy: "schema_compatible_rollback_candidate_or_provider_specific_fix_forward",
      verification: "webhook_secret_replay_queue_and_private_chat_checks",
    },
    {
      authority: "domain_incident_owner",
      containment: "switch_affected_shop_to_platform_subdomain_and_purge_hostname_cache",
      signal: "custom_domain_misroute_or_certificate_failure",
      strategy: "revert_canonical_mapping_without_broad_dns_mutation",
      verification: "hostname_ssl_dns_and_cross_tenant_routing",
    },
    {
      authority: "operations_owner",
      containment: "pause_consumers_if_retries_amplify_and_preserve_dlq_evidence",
      signal: "queue_backlog_or_dlq_growth",
      strategy: "schema_compatible_rollback_candidate_then_bounded_replay",
      verification: "queue_age_retry_rate_dlq_and_exactly_once_side_effects",
    },
  ];
}

export function buildProductionRollbackRehearsalArtifact(input) {
  const evidence = input?.evidence;
  const candidate = evidence?.rollback?.candidate;
  const migrationNames = validateSourceMigrationNames(input?.migrationNames);
  const expectedMigrationName = migrationNames.at(-1);
  const expectedMigrationLedgerSha256 = fingerprint(migrationNames);
  const now = input?.now instanceof Date ? input.now.getTime() : Date.now();
  const invariants = Array.isArray(candidate?.invariants) ? candidate.invariants : [];
  if (!RELEASE_ID_PATTERN.test(evidence?.releaseId ?? "")
    || PLACEHOLDER_PATTERN.test(evidence.releaseId)
    || candidate?.schemaVersion !== 2
    || candidate?.migrationName !== expectedMigrationName
    || candidate?.migrationLedgerSha256 !== expectedMigrationLedgerSha256
    || invariants.length < REQUIRED_PRODUCTION_ROLLBACK_INVARIANTS.length
    || new Set(invariants).size !== invariants.length
    || invariants.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9_]{2,127}$/u.test(name))
    || !REQUIRED_PRODUCTION_ROLLBACK_INVARIANTS.every((name) => invariants.includes(name))
    || !/^[a-f0-9]{40}$/u.test(evidence?.commitSha ?? "")
    || !/^[a-f0-9]{40}$/u.test(evidence?.treeSha ?? "")
    || !/^[a-f0-9]{40}$/u.test(candidate?.commitSha ?? "")
    || !/^[a-f0-9]{40}$/u.test(candidate?.treeSha ?? "")
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(evidence?.candidateWorkerVersion ?? "")
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(evidence?.previousWorkerVersion ?? "")
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(candidate?.workerVersion ?? "")
    || candidate.workerVersion === evidence.previousWorkerVersion
    || candidate.workerVersion === evidence.candidateWorkerVersion) {
    throw new Error("production_rollback_rehearsal_input_invalid");
  }
  return {
    environment: "production",
    invariants: [...invariants],
    migrationLedger: {
      latest: expectedMigrationName,
      sha256: expectedMigrationLedgerSha256,
    },
    rehearsal: {
      authorizesProductionAdmission: false,
      completedAt: new Date(now).toISOString(),
      kind: "schema_compatibility_validation",
      result: "validated",
    },
    releaseSource: {
      commitSha: evidence.commitSha,
      treeSha: evidence.treeSha,
    },
    rollbackSource: {
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
    },
    schemaVersion: 1,
    workerVersions: {
      candidate: evidence.candidateWorkerVersion,
      current: evidence.previousWorkerVersion,
      rollback: candidate.workerVersion,
    },
  };
}

export async function writeProductionRollbackRehearsalArtifact(input) {
  const root = input?.repositoryRoot ?? repositoryRoot;
  const artifact = buildProductionRollbackRehearsalArtifact(input);
  const repositoryState = readRepositoryGitState(root);
  if (repositoryState.clean !== true
    || repositoryState.commitSha !== input.evidence.commitSha
    || repositoryState.treeSha !== input.evidence.treeSha) {
    throw new Error("production_rollback_rehearsal_source_mismatch");
  }
  const rollbackCommit = spawnSync("git", ["rev-parse", "--verify", `${input.evidence.rollback.candidate.commitSha}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  });
  const rollbackTree = spawnSync("git", ["rev-parse", "--verify", `${input.evidence.rollback.candidate.commitSha}^{tree}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (rollbackCommit.error || rollbackCommit.status !== 0
    || rollbackCommit.stdout.trim() !== input.evidence.rollback.candidate.commitSha
    || rollbackTree.error || rollbackTree.status !== 0
    || rollbackTree.stdout.trim() !== input.evidence.rollback.candidate.treeSha) {
    throw new Error("production_rollback_rehearsal_rollback_source_invalid");
  }
  const releaseId = input.evidence.releaseId;
  const evidenceRef = `.wrangler/releases/${releaseId}/rollback-rehearsal.json`;
  const artifactPath = resolve(root, evidenceRef);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await mkdir(dirname(artifactPath), { mode: 0o700, recursive: true });
  await writeFile(artifactPath, bytes, { mode: 0o600 });
  await chmod(artifactPath, 0o600);
  return {
    artifact,
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    evidenceRef,
  };
}

export function buildReleaseArtifacts(input) {
  if (!RELEASE_ID_PATTERN.test(input.evidence?.releaseId ?? "") || PLACEHOLDER_PATTERN.test(input.evidence.releaseId)) {
    throw new Error("release_id_invalid");
  }
  const migrationNames = validateSourceMigrationNames(input.migrationNames);
  const requiresCurrentChainHardening = migrationNames.includes("0090_payos_provider_claim_clear_guard.sql");
  const commerceEvidenceValidation = input.commerceEvidenceValidation;
  const releaseInput = {
    ...input,
    commerceEvidenceValidation,
    requireReleaseHardening: input.requireReleaseHardening === true || requiresCurrentChainHardening,
  };
  const readiness = inspectProductionReadiness(releaseInput);
  if (!readiness.ok) throw new Error(`release_prerequisites_incomplete:${readiness.missing[0] ?? "unknown"}`);
  const migrationLedgerPrefix = Array.isArray(input.evidence.migrationLedgerPrefix)
    ? [...input.evidence.migrationLedgerPrefix]
    : [];
  if (migrationLedgerPrefix.length === 0
    || migrationLedgerPrefix.length > migrationNames.length
    || migrationLedgerPrefix.some((name, index) => name !== migrationNames[index])) {
    throw new Error("release_prerequisites_incomplete:evidence.migrationLedgerPrefix");
  }
  const configFingerprint = fingerprint({
    production: input.wranglerConfig.env.production,
    productionSpec: input.productionSpec,
  });
  const manifest = {
    backup: {
      bookmarkRecorded: true,
      completedAt: input.evidence.backup.completedAt,
      restoreDrillCompletedAt: input.evidence.backup.restoreDrillCompletedAt,
      restoreDrillPassed: true,
    },
    candidateWorkerVersion: input.evidence.candidateWorkerVersion,
    commitSha: input.evidence.commitSha,
    configFingerprintSha256: configFingerprint,
    createdAt: input.now.toISOString(),
    environment: "production",
    manualAcceptance: {
      customDomain: input.evidence.manualAcceptance.customDomain === true,
      evidenceRef: input.evidence.manualAcceptance.evidenceRef,
      observedAt: input.evidence.manualAcceptance.observedAt,
      paymentSignedEvent: input.evidence.manualAcceptance.paymentSignedEvent === true,
      telegram: input.evidence.manualAcceptance.telegram === true,
      website: input.evidence.manualAcceptance.website === true,
    },
    ...((input.evidence.legalSupport !== undefined || input.evidence.secretInventory !== undefined) ? {
      legalSupport: {
        accepted: input.evidence.legalSupport.accepted === true,
        artifactSchemaVersion: input.evidence.legalSupport.artifactSchemaVersion,
        artifactSha256: input.evidence.legalSupport.artifactSha256,
        evidenceRef: input.evidence.legalSupport.evidenceRef,
        observedAt: input.evidence.legalSupport.observedAt,
      },
      releaseEvidenceHardeningVersion: 1,
      secretInventory: {
        artifactSha256: input.evidence.secretInventory.artifactSha256,
        evidenceRef: input.evidence.secretInventory.evidenceRef,
        mode: input.evidence.secretInventory.mode,
        requiredNames: [...input.evidence.secretInventory.requiredNames].sort(),
        schemaVersion: input.evidence.secretInventory.schemaVersion,
      },
    } : {}),
    ...(releaseInput.requireReleaseHardening ? {
      candidateBoundEvidence: projectCandidateBoundReleaseEvidence(input.evidence),
    } : {}),
    providerAcceptance: projectAcceptance(input.evidence.providerAcceptance, RELEASE_CHANNEL_KEYS.slice(1)),
    releaseScope: {
      activeChannels: [...input.evidence.releaseScope.activeChannels],
      deferredChannels: [...input.evidence.releaseScope.deferredChannels],
    },
    commerceAcceptance: projectAcceptance(input.evidence.commerceAcceptance, REQUIRED_COMMERCE_ACCEPTANCE_KEYS, commerceEvidenceValidation),
    stagingBinding: {
      manifestRef: input.evidence.staging.manifestRef,
      manifestSha256: input.evidence.staging.manifestSha256,
      releaseId: input.evidence.staging.releaseId,
      workerVersion: input.evidence.staging.workerVersion,
    },
    migrationLedgerPrefix,
    migrationNames,
    packageVersion: input.packageVersion,
    pilotShopCount: input.evidence.pilot.shopCount,
    previousWorkerVersion: input.evidence.previousWorkerVersion,
    rollbackCandidate: evaluateProductionRollbackCandidate(input.evidence, input.now, migrationNames).candidate,
    releaseEvidenceFingerprintSha256: fingerprint(input.evidence),
    releaseId: input.evidence.releaseId,
    schemaVersion: 2,
    treeSha: input.evidence.treeSha,
  };
  return { manifest, rollbackMatrix: buildRollbackMatrix() };
}

export function validateProductionDeployAdmission(input) {
  if (typeof input.manifest !== "object" || input.manifest === null || Array.isArray(input.manifest)) {
    throw new Error("production_release_manifest_invalid");
  }
  if (input.repositoryClean !== true) throw new Error("production_release_source_dirty");
  if (!/^[a-f0-9]{40}$/u.test(input.repositoryCommitSha ?? "")) {
    throw new Error("production_release_commit_unavailable");
  }
  if (input.evidence?.commitSha !== input.repositoryCommitSha) {
    throw new Error("production_release_evidence_commit_mismatch");
  }
  if (!/^[a-f0-9]{40}$/u.test(input.repositoryTreeSha ?? "")) {
    throw new Error("production_release_tree_unavailable");
  }
  if (input.evidence?.treeSha !== input.repositoryTreeSha) {
    throw new Error("production_release_evidence_tree_mismatch");
  }
  if (input.requireRollbackArtifact === true && input.rollbackArtifactValidation?.accepted !== true) {
    throw new Error("production_rollback_artifact_invalid");
  }

  const createdAt = safeDate(input.manifest.createdAt);
  if (createdAt === null || createdAt > input.now.getTime() + 5 * 60_000) {
    throw new Error("production_release_manifest_created_at_invalid");
  }

  const expected = buildReleaseArtifacts(input).manifest;
  expected.createdAt = input.manifest.createdAt;
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(input.manifest).sort();
  if (!isDeepStrictEqual(actualKeys, expectedKeys)) {
    throw new Error("production_release_manifest_shape_invalid");
  }
  for (const key of expectedKeys) {
    if (!isDeepStrictEqual(input.manifest[key], expected[key])) {
      throw new Error(`production_release_manifest_mismatch:${key}`);
    }
  }
  return {
    candidateWorkerVersion: input.manifest.candidateWorkerVersion,
    commitSha: input.repositoryCommitSha,
    migrationLedgerSha256: input.manifest.rollbackCandidate.migrationLedgerSha256,
    migrationLedgerPrefix: input.manifest.migrationLedgerPrefix,
    previousWorkerVersion: input.manifest.previousWorkerVersion,
    releaseId: input.manifest.releaseId,
    rollbackArtifactSha256: input.manifest.rollbackCandidate.artifactSha256,
    rollbackCandidateWorkerVersion: input.manifest.rollbackCandidate.workerVersion,
    treeSha: input.repositoryTreeSha,
  };
}

function readRepositoryGitState(root) {
  const commit = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (commit.error || commit.status !== 0) {
    throw new Error("production_release_commit_unavailable");
  }
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (status.error || status.status !== 0) {
    throw new Error("production_release_source_status_unavailable");
  }
  const tree = spawnSync("git", ["rev-parse", "--verify", "HEAD^{tree}"], {
    cwd: root,
    encoding: "utf8",
  });
  if (tree.error || tree.status !== 0) {
    throw new Error("production_release_tree_unavailable");
  }
  return {
    commitSha: commit.stdout.trim(),
    clean: status.stdout.trim().length === 0,
    treeSha: tree.stdout.trim(),
  };
}

export function validateProductionRollbackArtifact(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const evidence = input.evidence;
  const candidate = evidence?.rollback?.candidate;
  const migrationNames = validateSourceMigrationNames(input.migrationNames);
  if (typeof evidence?.releaseId !== "string"
    || !RELEASE_ID_PATTERN.test(evidence.releaseId)
    || PLACEHOLDER_PATTERN.test(evidence.releaseId)
    || typeof candidate?.commitSha !== "string"
    || !/^[a-f0-9]{40}$/u.test(candidate.commitSha)
    || typeof candidate?.treeSha !== "string"
    || !/^[a-f0-9]{40}$/u.test(candidate.treeSha)
    || typeof candidate?.artifactSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(candidate.artifactSha256)) {
    throw new Error("production_rollback_artifact_binding_mismatch");
  }
  const expectedRef = `.wrangler/releases/${evidence?.releaseId}/rollback-rehearsal.json`;
  if (candidate?.evidenceRef !== expectedRef
    || evidence?.rollback?.rehearsalEvidenceRef !== expectedRef) {
    throw new Error("production_rollback_artifact_ref_invalid");
  }
  const releaseDirectory = resolve(root, ".wrangler", "releases", evidence.releaseId);
  const artifactPath = resolve(root, candidate.evidenceRef);
  const artifactRelative = relative(releaseDirectory, artifactPath);
  if (artifactRelative !== "rollback-rehearsal.json") {
    throw new Error("production_rollback_artifact_ref_invalid");
  }
  let stat;
  try {
    stat = lstatSync(artifactPath);
  } catch {
    throw new Error("production_rollback_artifact_missing");
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error("production_rollback_artifact_permissions_invalid");
  }
  let bytes;
  let artifact;
  try {
    bytes = readFileSync(artifactPath);
    artifact = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("production_rollback_artifact_invalid");
  }
  const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  if (artifactSha256 !== candidate.artifactSha256) {
    throw new Error("production_rollback_artifact_hash_mismatch");
  }
  if (!Array.isArray(candidate.invariants)) {
    throw new Error("production_rollback_artifact_binding_mismatch");
  }
  const rollbackCommit = spawnSync(
    "git",
    ["rev-parse", "--verify", `${candidate.commitSha}^{commit}`],
    { cwd: root, encoding: "utf8" },
  );
  if (rollbackCommit.error || rollbackCommit.status !== 0
    || rollbackCommit.stdout.trim() !== candidate.commitSha) {
    throw new Error("production_rollback_artifact_rollback_source_invalid");
  }
  const rollbackTree = spawnSync(
    "git",
    ["rev-parse", "--verify", `${candidate.commitSha}^{tree}`],
    { cwd: root, encoding: "utf8" },
  );
  if (rollbackTree.error || rollbackTree.status !== 0
    || rollbackTree.stdout.trim() !== candidate.treeSha) {
    throw new Error("production_rollback_artifact_rollback_source_invalid");
  }
  const expected = {
    environment: "production",
    invariants: [...candidate.invariants],
    migrationLedger: {
      latest: migrationNames.at(-1),
      sha256: fingerprint(migrationNames),
    },
    rehearsal: {
      completedAt: evidence.rollback.rehearsedAt,
      authorizesProductionAdmission: true,
      kind: "live_rollback_rehearsal",
      result: "passed",
    },
    releaseSource: {
      commitSha: evidence.commitSha,
      treeSha: evidence.treeSha,
    },
    rollbackSource: {
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
    },
    schemaVersion: 1,
    workerVersions: {
      candidate: evidence.candidateWorkerVersion,
      current: evidence.previousWorkerVersion,
      rollback: candidate.workerVersion,
    },
  };
  if (!isDeepStrictEqual(artifact, expected)) {
    throw new Error("production_rollback_artifact_binding_mismatch");
  }
  return {
    accepted: true,
    artifactSha256,
    migrationLedgerSha256: expected.migrationLedger.sha256,
    rollbackCandidateWorkerVersion: candidate.workerVersion,
  };
}

export async function assertProductionDeployAdmission(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const manifestPath = resolve(root, input.manifestPath);
  let manifestStat;
  try {
    manifestStat = await lstat(manifestPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && error.code === "ENOENT") {
      throw new Error("production_release_manifest_missing", { cause: error });
    }
    throw new Error("production_release_manifest_read_failed", { cause: error });
  }
  if (!manifestStat.isFile() || (manifestStat.mode & 0o077) !== 0) {
    throw new Error("production_release_manifest_permissions_invalid");
  }

  const evidencePath = input.evidencePath
    ?? resolve(root, ".wrangler/release/production-evidence.json");
  const specPath = input.specPath ?? resolve(root, "infra/environments/production.json");
  const [manifest, evidence, productionSpec, wranglerConfig, packageJson, migrationNames] = await Promise.all([
    readOptionalJson(manifestPath),
    readOptionalJson(evidencePath),
    readOptionalJson(specPath),
    readFile(resolve(root, "wrangler.jsonc"), "utf8").then((text) => JSON.parse(text)),
    readFile(resolve(root, "package.json"), "utf8").then((text) => JSON.parse(text)),
    listMigrationNames(root),
  ]);
  if (manifest === null) throw new Error("production_release_manifest_missing");
  if (evidence === null) throw new Error("production_evidence_missing");
  if (productionSpec === null) throw new Error("production_spec_missing");
  const gitState = readRepositoryGitState(root);
  const rollbackArtifactValidation = validateProductionRollbackArtifact({
    evidence,
    migrationNames,
    repositoryRoot: root,
  });
  const commerceEvidenceValidation = await validateCommerceUatArtifacts({
    evidence,
    now: input.now ?? new Date(),
    repositoryRoot: root,
  });
  const admission = validateProductionDeployAdmission({
    commerceEvidenceValidation,
    evidence,
    manifest,
    migrationNames,
    now: input.now ?? new Date(),
    packageVersion: String(packageJson.version ?? "unknown"),
    productionSpec,
    repositoryClean: gitState.clean,
    repositoryCommitSha: gitState.commitSha,
    repositoryTreeSha: gitState.treeSha,
    requireRollbackArtifact: true,
    rollbackArtifactValidation,
    workerSecretNames: input.workerSecretNames,
    wranglerConfig,
  });
  const canonicalManifestPath = resolve(
    root,
    ".wrangler",
    "releases",
    admission.releaseId,
    "release-manifest.json",
  );
  if (manifestPath !== canonicalManifestPath) {
    throw new Error("production_release_manifest_path_invalid");
  }
  return admission;
}

export async function assertProductionWorkerDeployAdmission(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const releaseAdmission = await (
    input.assertReleaseAdmissionImplementation ?? assertProductionDeployAdmission
  )({
    manifestPath: input.manifestPath,
    now: input.now,
    repositoryRoot: root,
    workerSecretNames: input.workerSecretNames,
  });
  if (input.requireDedicatedWorkerDeployToken === true) {
    requireCloudflareWorkerDeployToken(input.environment);
  }
  const [productionSpec, stagingSpec, wranglerConfig] = await Promise.all([
    input.productionSpec === undefined
      ? readOptionalJson(resolve(root, "infra/environments/production.json"))
      : input.productionSpec,
    input.stagingSpec === undefined
      ? readOptionalJson(resolve(root, "infra/environments/staging.json"))
      : input.stagingSpec,
    input.wranglerConfig === undefined
      ? readFile(resolve(root, "wrangler.jsonc"), "utf8").then((text) => JSON.parse(text))
      : input.wranglerConfig,
  ]);
  if (productionSpec === null) throw new Error("production_spec_missing");
  if (stagingSpec === null) throw new Error("staging_spec_missing");
  let rollbackWorkerVersionBinding = input.rollbackWorkerVersionBinding;
  if (rollbackWorkerVersionBinding === undefined
    && input.assertReleaseAdmissionImplementation === undefined) {
    const manifest = await readOptionalJson(resolve(root, input.manifestPath));
    const rollback = manifest?.rollbackCandidate;
    rollbackWorkerVersionBinding = {
      commitSha: rollback?.commitSha,
      manifestRef: `.wrangler/releases/${manifest?.releaseId}/release-manifest.json`,
      releaseId: manifest?.releaseId,
      treeSha: rollback?.treeSha,
    };
  }
  if (input.requireWorkerVersionBinding === true && rollbackWorkerVersionBinding === undefined) {
    throw new Error("production_rollback_worker_version_binding_invalid");
  }
  const workerAdmission = await (
    input.workerIdentityImplementation ?? assertProductionWorkerIdentityAdmission
  )({
    environment: input.environment,
    fetchImplementation: input.fetchImplementation,
    productionSpec,
    repositoryRoot: root,
    runWranglerImplementation: input.runWranglerImplementation,
    stagingSpec,
    token: input.token,
    requireCurrentWorkerVersion: true,
    infrastructureAdmissionMode: input.infrastructureAdmissionMode ?? "exact",
    wranglerConfig,
  });
  assertProductionWorkerVersionAdmission({
    candidateWorkerVersion: releaseAdmission.candidateWorkerVersion,
    candidateWorkerVersionBinding: input.requireWorkerVersionBinding === true
      ? {
        commitSha: releaseAdmission.commitSha,
        manifestRef: `.wrangler/releases/${releaseAdmission.releaseId}/release-manifest.json`,
        releaseId: releaseAdmission.releaseId,
        role: "candidate",
        treeSha: releaseAdmission.treeSha,
      }
      : undefined,
    currentWorkerVersion: workerAdmission.currentWorkerVersion,
    deployableWorkerVersionIds: workerAdmission.deployableWorkerVersionIds,
    deployableWorkerVersionInventory: workerAdmission.deployableWorkerVersionInventory,
    previousWorkerVersion: releaseAdmission.previousWorkerVersion,
    rollbackCandidateWorkerVersion: releaseAdmission.rollbackCandidateWorkerVersion,
    rollbackWorkerVersionBinding: input.requireWorkerVersionBinding === true
      ? { ...rollbackWorkerVersionBinding, role: "rollback" }
      : rollbackWorkerVersionBinding,
    workerVersionAdmissionMode: input.workerVersionAdmissionMode ?? "pre_candidate",
  });
  return {
    ...releaseAdmission,
    accountId: workerAdmission.accountId,
    databaseId: workerAdmission.databaseId,
    databaseName: workerAdmission.databaseName,
    workerName: workerAdmission.workerName,
    zoneId: workerAdmission.zoneId,
    zoneName: workerAdmission.zoneName,
  };
}

export function buildProductionWorkerVersionMessage(input) {
  if (!new Set(["candidate", "rollback"]).has(input?.role)
    || !/^[a-f0-9]{40}$/u.test(input?.commitSha ?? "")
    || !/^[a-f0-9]{40}$/u.test(input?.treeSha ?? "")
    || !RELEASE_ID_PATTERN.test(input?.releaseId ?? "")
    || PLACEHOLDER_PATTERN.test(input.releaseId)
    || typeof input?.manifestRef !== "string"
    || !input.manifestRef.startsWith(".wrangler/releases/")
    || !input.manifestRef.endsWith("/release-manifest.json")) {
    throw new Error("production_worker_upload_binding_invalid");
  }
  return JSON.stringify({
    commitSha: input.commitSha,
    manifestRef: input.manifestRef,
    releaseId: input.releaseId,
    role: input.role,
    treeSha: input.treeSha,
  });
}

export function assertProductionWorkerUploadResult(input) {
  const normalize = (value) => Array.isArray(value)
    && value.every((entry) => typeof entry?.id === "string" && Object.hasOwn(entry, "binding"))
    ? value
    : parseProductionWorkerDeployableVersionInventory(value);
  const before = normalize(input?.before);
  const after = normalize(input?.after);
  const beforeIds = new Set(before.map((entry) => entry.id));
  const additions = after.filter((entry) => !beforeIds.has(entry.id));
  if (additions.length !== 1) throw new Error("production_worker_upload_version_delta_invalid");
  const expected = input?.expectedBinding;
  const actual = additions[0].binding;
  const required = ["commitSha", "treeSha", "releaseId", "manifestRef"];
  if (expected?.role !== undefined) {
    if (!new Set(["candidate", "rollback"]).has(expected.role)) {
      throw new Error("production_worker_upload_binding_invalid");
    }
    required.push("role");
  }
  if (expected === null || typeof expected !== "object"
    || actual === null || typeof actual !== "object"
    || required.some((key) => typeof expected[key] !== "string" || actual[key] !== expected[key])) {
    throw new Error("production_worker_upload_binding_mismatch");
  }
  return {
    binding: actual,
    workerVersion: additions[0].id,
  };
}

/**
 * Require a fresh, non-empty production backup and isolated restore before a
 * normal Worker deploy.  Keep this as a separate admission so pure release
 * validators can continue to operate on synthetic evidence fixtures.
 */
export async function assertProductionContinuationDeployAdmission(input) {
  const accountId = input.accountId;
  const databaseId = input.databaseId;
  const databaseName = input.databaseName;
  const reviewedCommitSha = input.reviewedCommitSha;
  const implementation = input.assertContinuationEvidenceImplementation
    ?? assertFreshProductionContinuationEvidence;
  const evidence = await implementation({
    accountId,
    backupRoot: input.backupRoot,
    databaseId,
    databaseName,
    now: input.now,
    repositoryRoot: input.repositoryRoot ?? repositoryRoot,
    restoreRoot: input.restoreRoot,
    reviewedCommitSha,
  });
  const backupSnapshotId = evidence?.backup?.snapshotId;
  const backupChecksumSha256 = evidence?.backup?.checksumSha256;
  const restoreReportRef = evidence?.restore?.reportRef;
  const restoreSnapshotId = evidence?.restore?.snapshotId;
  if (
    typeof backupSnapshotId !== "string"
    || !/^[a-z0-9][a-z0-9._-]{7,128}$/u.test(backupSnapshotId)
    || typeof backupChecksumSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(backupChecksumSha256)
    || typeof restoreReportRef !== "string"
    || restoreReportRef.length === 0
    || typeof restoreSnapshotId !== "string"
    || !/^[a-z0-9][a-z0-9._-]{7,128}$/u.test(restoreSnapshotId)
  ) {
    throw new Error("production_continuation_evidence_invalid");
  }
  return {
    backupChecksumSha256,
    backupSnapshotId,
    restoreReportRef,
    restoreSnapshotId,
    reviewedCommitSha,
  };
}

function parseProductionDatabaseInvariantRows(output, issue) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`${issue}_invalid_json`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0
    || parsed.some((entry) => entry?.success !== true || !Array.isArray(entry?.results))) {
    throw new Error(`${issue}_invalid_result`);
  }
  return parsed.flatMap((entry) => entry.results);
}

function canonicalDatabaseObjectSql(value) {
  return value.trim().replace(/;$/u, "").replace(/\s+/gu, " ");
}

export function assertProductionDatabaseInvariantContract(input = {}) {
  const environmentName = input.environmentName ?? "production";
  if (!new Set(["staging", "production"]).has(environmentName)) {
    throw new Error("production_database_invariant_environment_invalid");
  }
  const migrationNames = validateSourceMigrationNames(input.migrationNames);
  const historicalMigrations = [
    "0078_dodo_billing_hardening.sql",
    "0081_dodo_catalog_contract.sql",
  ];
  for (const name of historicalMigrations) {
    if (!migrationNames.includes(name)) {
      throw new Error(`production_database_invariant_baseline_missing:${name}`);
    }
  }
  const baselineIndex = migrationNames.indexOf("0087_integrity_hardening.sql");
  if (baselineIndex === -1) {
    throw new Error("production_database_invariant_baseline_missing");
  }
  const coveredMigrations = [...historicalMigrations, ...migrationNames.slice(baselineIndex)];
  for (const name of coveredMigrations) {
    if (!Object.hasOwn(PRODUCTION_DATABASE_INVARIANT_REGISTRY, name)) {
      throw new Error(`production_database_invariant_registry_incomplete:${name}`);
    }
  }
  const registryEntries = coveredMigrations.map((name) => PRODUCTION_DATABASE_INVARIANT_REGISTRY[name]);
  const expectedObjects = Object.assign({}, ...registryEntries.map((entry) => entry.objects));
  const expectedColumns = Object.assign({}, ...registryEntries.map((entry) => entry.columns));
  const objectNames = Object.keys(expectedObjects).sort();
  const quotedObjectNames = objectNames.map((name) => `'${name}'`).join(", ");
  const objectSql = `SELECT type, name, sql FROM sqlite_schema WHERE name IN (${quotedObjectNames}) ORDER BY type, name;`;
  const columnsByTable = Map.groupBy(Object.keys(expectedColumns), (name) => name.split(".")[0]);
  const columnSql = [...columnsByTable.entries()].map(([table, names]) => (
    `SELECT '${table}' AS table_name, name, type, "notnull" AS not_null, dflt_value, pk FROM pragma_table_info('${table}') WHERE name IN (${names.map((name) => `'${name.split(".")[1]}'`).join(", ")})`
  )).join(" UNION ALL ").concat(" ORDER BY table_name, name;");
  const dataSql = `SELECT
    (SELECT COUNT(*) FROM shop_subscriptions AS subscription
      WHERE subscription.state = 'trialing'
        AND NOT EXISTS (SELECT 1 FROM account_trial_claims AS claim WHERE claim.shop_id = subscription.shop_id)) AS integrity_0087_trial_claim,
    (SELECT COUNT(*) FROM shop_customers AS customer
      WHERE customer.anonymized_at IS NOT NULL
        AND (customer.email_normalized IS NOT NULL OR customer.display_name IS NOT NULL OR customer.status != 'blocked')) AS integrity_0087_anonymized_customer,
    (SELECT COUNT(*) FROM checkout_recovery_capabilities AS recovery
      WHERE recovery.consumed_order_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM orders AS order_row
          WHERE order_row.id = recovery.consumed_order_id AND order_row.shop_id = recovery.shop_id)) AS integrity_0087_checkout_recovery_tenant_order,
    (SELECT COUNT(*) FROM payment_integrations AS integration
      WHERE integration.provider_claim_generation IS NULL
        OR integration.provider_claim_state IS NULL
        OR integration.provider_claim_generation < 0
        OR NOT (
          (integration.provider_claim_state = 'idle' AND integration.provider_claim_nonce IS NULL AND integration.provider_claim_target_fingerprint IS NULL)
          OR (integration.provider_claim_state IN ('in_flight', 'ambiguous') AND integration.provider_claim_nonce IS NOT NULL AND integration.provider_claim_target_fingerprint IS NOT NULL)
          OR integration.provider_claim_state = 'quarantined'
        )) AS integrity_0088_provider_claim_state,
    (SELECT COUNT(*) FROM payment_credentials AS credential
      WHERE credential.provider_claim_nonce IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM payment_integrations AS integration
          WHERE integration.id = credential.integration_id
            AND integration.shop_id = credential.shop_id
            AND integration.provider = credential.provider
            AND integration.provider_claim_nonce = credential.provider_claim_nonce)) AS integrity_0088_provider_claim_scope,
    (SELECT COUNT(*) FROM payment_integrations AS integration
      WHERE integration.provider = 'payos'
        AND integration.provider_identity_fingerprint IS NOT NULL
        AND integration.active_credential_id IS NULL
        AND integration.status IN ('pending', 'error')
        AND integration.provider_claim_nonce IS NULL
        AND integration.provider_claim_state = 'idle'
        AND integration.provider_claim_target_fingerprint IS NULL) AS integrity_0089_unfenced_integration_claim,
    (SELECT COUNT(*) FROM payment_credentials AS credential
      WHERE credential.provider = 'payos'
        AND credential.provider_ownership_fingerprint IS NOT NULL
        AND credential.status IN ('pending', 'error')
        AND credential.provider_claim_nonce IS NULL
        AND EXISTS (SELECT 1 FROM payment_integrations AS integration
          WHERE integration.id = credential.integration_id
            AND integration.shop_id = credential.shop_id
            AND integration.provider = credential.provider
            AND integration.provider_claim_state = 'quarantined'
            AND integration.provider_claim_nonce IS NOT NULL
            AND integration.provider_claim_target_fingerprint IS NULL)) AS integrity_0089_unfenced_credential_claim,
    (SELECT COUNT(*) FROM order_access_recovery_tokens AS recovery
      WHERE NOT EXISTS (SELECT 1 FROM orders AS order_row
          WHERE order_row.shop_id = recovery.shop_id
            AND order_row.id = recovery.order_id
            AND order_row.customer_id = recovery.customer_id)
        OR NOT EXISTS (SELECT 1 FROM shop_customers AS customer
          WHERE customer.shop_id = recovery.shop_id
            AND customer.id = recovery.customer_id)) AS integrity_0091_recovery_scope,
    (SELECT COUNT(*) FROM order_access_recovery_tokens AS recovery
      WHERE recovery.expires_at <= recovery.issued_at
        OR recovery.retention_expires_at <= recovery.expires_at
        OR (recovery.consumed_at IS NULL) != (recovery.consumed_request_id IS NULL)
        OR (recovery.consumed_at IS NULL) != (recovery.previous_order_token_hash IS NULL)
        OR (recovery.consumed_at IS NULL) != (recovery.replacement_order_token_hash IS NULL)
        OR (recovery.consumed_at IS NOT NULL
          AND recovery.previous_order_token_hash = recovery.replacement_order_token_hash)
        OR (recovery.consumed_at IS NOT NULL AND recovery.consumed_at < recovery.issued_at)
        OR (recovery.revoked_at IS NOT NULL AND recovery.revoked_at < recovery.issued_at)
        OR (recovery.consumed_at IS NOT NULL AND recovery.revoked_at IS NOT NULL)
        OR (recovery.redacted_at IS NOT NULL AND recovery.consumed_at IS NULL)
        OR (recovery.redacted_at IS NOT NULL
          AND recovery.redacted_at < recovery.retention_expires_at)) AS integrity_0091_recovery_terminal,
    (SELECT COUNT(*) FROM shop_domains AS domain
      WHERE domain.type = 'custom'
        AND (domain.status = 'active' OR domain.is_primary = 1)
        AND NOT COALESCE((
          domain.ownership_verified_at IS NOT NULL
          AND domain.hostname_status = 'active'
          AND domain.ssl_status = 'active'
          AND domain.dns_status = 'active'
          AND domain.delete_requested_at IS NULL
          AND domain.deleted_at IS NULL
          AND json_extract(domain.validation_metadata_json, '$.turnstile.status') = 'active'
          AND json_extract(domain.validation_metadata_json, '$.turnstile.hostname') = domain.hostname_normalized
          AND json_extract(domain.validation_metadata_json, '$.turnstile.mode') = 'operator_managed'
          AND json_extract(domain.validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'
          AND json_type(domain.validation_metadata_json, '$.turnstile.checkedAt') = 'text'
          AND julianday(json_extract(domain.validation_metadata_json, '$.turnstile.checkedAt')) IS NOT NULL
          AND julianday(json_extract(domain.validation_metadata_json, '$.turnstile.checkedAt')) >= julianday('now', '-12 hours')
          AND julianday(json_extract(domain.validation_metadata_json, '$.turnstile.checkedAt')) <= julianday('now')
        ), 0)) AS integrity_0093_custom_domain_turnstile,
    (SELECT COUNT(*) FROM shops AS shop
      WHERE shop.canonical_domain_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM shop_domains AS candidate
          WHERE candidate.id = shop.canonical_domain_id AND candidate.type = 'custom')
        AND NOT EXISTS (SELECT 1 FROM shop_domains AS canonical
          WHERE canonical.id = shop.canonical_domain_id
            AND canonical.shop_id = shop.id
            AND canonical.type = 'custom'
            AND canonical.status = 'active'
            AND canonical.is_primary = 1
            AND canonical.ownership_verified_at IS NOT NULL
            AND canonical.hostname_status = 'active'
            AND canonical.ssl_status = 'active'
            AND canonical.dns_status = 'active'
            AND canonical.delete_requested_at IS NULL
            AND canonical.deleted_at IS NULL
            AND json_extract(canonical.validation_metadata_json, '$.turnstile.status') = 'active'
            AND json_extract(canonical.validation_metadata_json, '$.turnstile.hostname') = canonical.hostname_normalized
            AND json_extract(canonical.validation_metadata_json, '$.turnstile.mode') = 'operator_managed'
            AND json_extract(canonical.validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'
            AND json_type(canonical.validation_metadata_json, '$.turnstile.checkedAt') = 'text'
            AND julianday(json_extract(canonical.validation_metadata_json, '$.turnstile.checkedAt')) IS NOT NULL
            AND julianday(json_extract(canonical.validation_metadata_json, '$.turnstile.checkedAt')) >= julianday('now', '-12 hours')
            AND julianday(json_extract(canonical.validation_metadata_json, '$.turnstile.checkedAt')) <= julianday('now'))
      ) AS integrity_0093_custom_domain_canonical,
    (SELECT COUNT(*) FROM auth_request_admissions AS admission
      WHERE admission.action NOT IN ('magic_link_request', 'shop_create')
        OR length(admission.requester_hash) NOT BETWEEN 16 AND 128
        OR admission.window_ends_at <= admission.window_started_at
        OR (admission.subject_hash IS NOT NULL
          AND length(admission.subject_hash) NOT BETWEEN 16 AND 128)
        OR admission.delivery_permitted NOT IN (0, 1)
        OR (admission.action = 'shop_create'
          AND (admission.subject_hash IS NULL OR admission.delivery_permitted != 1))
      ) AS integrity_0094_auth_request_admission,
    (SELECT COUNT(*) FROM outbox_jobs AS job
      WHERE job.kind = 'order_paid' AND job.status != 'completed'
      ) AS integrity_0095_legacy_order_paid_outbox,
    (SELECT COUNT(*) FROM telegram_integrations AS integration
      WHERE integration.integration_generation <= 0
        OR integration.generation_state NOT IN ('active', 'draining')
      ) AS integrity_0095_telegram_generation_state,
    (SELECT COUNT(*) FROM telegram_updates AS update_row
      LEFT JOIN telegram_integrations AS integration
        ON integration.id = update_row.integration_id
        AND integration.shop_id = update_row.shop_id
      WHERE update_row.integration_generation <= 0
        OR integration.id IS NULL
        OR (update_row.status = 'processing'
          AND (integration.generation_state != 'active'
            OR integration.integration_generation != update_row.integration_generation
            OR integration.active_credential_id IS NOT update_row.credential_id))
      ) AS integrity_0095_telegram_update_generation,
    (SELECT COUNT(*) FROM telegram_actions AS action_row
      LEFT JOIN telegram_integrations AS integration
        ON integration.id = action_row.integration_id
        AND integration.shop_id = action_row.shop_id
      WHERE action_row.integration_generation <= 0
        OR integration.id IS NULL
      ) AS integrity_0097_telegram_action_generation,
    (SELECT COUNT(*) FROM telegram_action_history AS history
      LEFT JOIN telegram_integrations AS integration
        ON integration.id = history.integration_id
        AND integration.shop_id = history.shop_id
      WHERE history.integration_generation <= 0
        OR integration.id IS NULL
        OR history.integration_generation > integration.integration_generation
      ) AS integrity_0097_telegram_action_history;`;
  const runner = input.runWranglerImplementation ?? runWrangler;
  const run = (sql, issue) => {
    try {
      return parseProductionDatabaseInvariantRows(runner([
        "d1", "execute", "PLATFORM_DB", "--env", environmentName, "--remote",
        "--command", sql, "--json",
      ], { cwd: input.repositoryRoot ?? repositoryRoot, env: input.environment }).stdout, issue);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${issue}_`)) throw error;
      throw new Error(`${issue}_unavailable`, { cause: error });
    }
  };
  const objectRows = run(objectSql, "production_database_invariant_object_query");
  if (objectRows.length !== objectNames.length) {
    throw new Error("production_database_invariant_object_query_invalid_result");
  }
  const observedObjects = new Map();
  for (const row of objectRows) {
    let expectedType = "trigger";
    if (typeof row?.name === "string" && row.name.startsWith("idx_")) expectedType = "index";
    if (["auth_request_admissions", "order_access_recovery_tokens", "payment_credentials", "payment_integrations", "telegram_actions", "telegram_action_history", "telegram_updates"].includes(row?.name)) expectedType = "table";
    if (typeof row?.name !== "string" || !Object.hasOwn(expectedObjects, row.name)
      || row.type !== expectedType || typeof row.sql !== "string" || observedObjects.has(row.name)) {
      throw new Error("production_database_invariant_object_query_invalid_result");
    }
    const digest = createHash("sha256").update(canonicalDatabaseObjectSql(row.sql)).digest("hex");
    if (digest !== expectedObjects[row.name]) {
      throw new Error(`production_database_invariant_definition_mismatch:${row.type}:${row.name}`);
    }
    observedObjects.set(row.name, digest);
  }
  const columnRows = run(columnSql, "production_database_invariant_column_query");
  const observedColumns = {};
  for (const row of columnRows) {
    const key = `${row?.table_name}.${row?.name}`;
    if (!Object.hasOwn(expectedColumns, key) || Object.hasOwn(observedColumns, key)) {
      throw new Error("production_database_invariant_column_query_invalid_result");
    }
    observedColumns[key] = {
      defaultValue: row.dflt_value,
      notNull: row.not_null,
      primaryKey: row.pk,
      type: row.type,
    };
  }
  if (!isDeepStrictEqual(canonicalize(observedColumns), canonicalize(expectedColumns))) {
    throw new Error("production_database_invariant_column_query_invalid_result");
  }
  const dataRows = run(dataSql, "production_database_invariant_data_query");
  const expectedDataCodes = [
    "integrity_0087_anonymized_customer",
    "integrity_0087_checkout_recovery_tenant_order",
    "integrity_0087_trial_claim",
    "integrity_0088_provider_claim_scope",
    "integrity_0088_provider_claim_state",
    "integrity_0089_unfenced_credential_claim",
    "integrity_0089_unfenced_integration_claim",
    "integrity_0091_recovery_scope",
    "integrity_0091_recovery_terminal",
    "integrity_0093_custom_domain_canonical",
    "integrity_0093_custom_domain_turnstile",
    "integrity_0094_auth_request_admission",
    "integrity_0095_legacy_order_paid_outbox",
    "integrity_0095_telegram_generation_state",
    "integrity_0095_telegram_update_generation",
    "integrity_0097_telegram_action_generation",
    "integrity_0097_telegram_action_history",
  ];
  if (dataRows.length !== 1
    || !isDeepStrictEqual(Object.keys(dataRows[0] ?? {}).sort(), expectedDataCodes)
    || expectedDataCodes.some((code) => !Number.isSafeInteger(dataRows[0][code]) || dataRows[0][code] < 0)) {
    throw new Error("production_database_invariant_data_query_invalid_result");
  }
  for (const code of expectedDataCodes) {
    if (dataRows[0][code] !== 0) {
      throw new Error(`production_database_invariant_data_violation:${code}`);
    }
  }
  return {
    checks: expectedDataCodes.map((code) => ({ code, ok: true, violationCount: 0 })),
    invariantNames: [...REQUIRED_PRODUCTION_ROLLBACK_INVARIANTS].sort(),
    objectDefinitionsSha256: fingerprint(Object.fromEntries([...observedObjects].sort())),
    ok: true,
  };
}

export async function assertProductionDatabaseDeployAdmission(input = {}) {
  const root = input.repositoryRoot ?? repositoryRoot;
  let migrationNames;
  try {
    migrationNames = await listMigrationNames(root);
  } catch {
    throw new Error("production_deploy_source_migration_ledger_invalid");
  }
  const ledgerImplementation = input.assertMigrationLedgerImplementation;
  const preflightImplementation = input.assertDatabasePreflightImplementation;
  const postMigrationImplementation = input.assertPostMigrationContractImplementation;
  if (typeof ledgerImplementation !== "function"
    || typeof preflightImplementation !== "function"
    || typeof postMigrationImplementation !== "function") {
    throw new Error("production_deploy_database_admission_invalid");
  }
  const shared = {
    environment: input.environment,
    migrationNames,
    repositoryRoot: root,
    runWranglerImplementation: input.runWranglerImplementation,
  };
  const ledger = await ledgerImplementation(shared);
  if (!Array.isArray(ledger?.migrationNames)
    || ledger.migrationNames.length !== migrationNames.length
    || ledger.migrationNames.some((name, index) => name !== migrationNames[index])) {
    throw new Error("production_deploy_migration_ledger_incomplete");
  }
  const preflight = await preflightImplementation({
    ...shared,
    requirePaymentProviderSchema: true,
  });
  if (preflight?.ok !== true
    || !Array.isArray(preflight.checks)
    || preflight.checks.length === 0
    || preflight.checks.some((check) => check?.ok !== true || typeof check?.code !== "string")) {
    throw new Error("production_deploy_database_preflight_failed");
  }
  const preflightSafetyChecks = preflight.checks
    .map((check) => ({ code: check.code, ok: true }))
    .sort((left, right) => left.code.localeCompare(right.code));
  if (new Set(preflightSafetyChecks.map((check) => check.code)).size !== preflightSafetyChecks.length) {
    throw new Error("production_deploy_database_preflight_failed");
  }
  const postMigration = await postMigrationImplementation({
    ...shared,
    environmentName: "production",
  });
  if (postMigration?.ok !== true) {
    throw new Error("production_deploy_post_migration_contract_failed");
  }
  const invariants = await (
    input.assertDatabaseInvariantContractImplementation ?? assertProductionDatabaseInvariantContract
  )(shared);
  if (invariants?.ok !== true
    || !Array.isArray(invariants.checks)
    || invariants.checks.length === 0
    || invariants.checks.some((check) => check?.ok !== true)) {
    throw new Error("production_deploy_database_invariant_contract_failed");
  }
  return {
    migrationNames: [...ledger.migrationNames],
    postMigrationFingerprintSha256: fingerprint({ invariants, postMigration }),
    preflightFingerprintSha256: fingerprint({ checks: preflightSafetyChecks, ok: true }),
  };
}

export async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("release_json_invalid", { cause: error });
    if (typeof error === "object" && error !== null && error.code === "ENOENT") return null;
    throw new Error("release_json_read_failed", { cause: error });
  }
}

export async function listMigrationNames(root = repositoryRoot) {
  return validateSourceMigrationNames(
    (await readdir(resolve(root, "migrations"))).filter((name) => name.endsWith(".sql")),
  );
}

export async function writeReleaseArtifacts(artifacts) {
  const releaseId = artifacts.manifest.releaseId;
  if (!RELEASE_ID_PATTERN.test(releaseId) || PLACEHOLDER_PATTERN.test(releaseId)) throw new Error("release_id_invalid");
  const directory = resolve(repositoryRoot, ".wrangler", "releases", releaseId);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const manifestPath = resolve(directory, "release-manifest.json");
  const rollbackPath = resolve(directory, "rollback-matrix.json");
  await writeFile(manifestPath, `${JSON.stringify(artifacts.manifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(rollbackPath, `${JSON.stringify(artifacts.rollbackMatrix, null, 2)}\n`, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  await chmod(rollbackPath, 0o600);
  return {
    manifestRef: `.wrangler/releases/${releaseId}/release-manifest.json`,
    rollbackRef: `.wrangler/releases/${releaseId}/rollback-matrix.json`,
  };
}

export function validatePilotSmokePlan(plan) {
  if (plan?.environment !== "production") throw new Error("pilot_plan_environment_invalid");
  if (!RELEASE_ID_PATTERN.test(plan?.releaseId ?? "") || PLACEHOLDER_PATTERN.test(plan.releaseId)) {
    throw new Error("pilot_plan_release_id_invalid");
  }
  if (!Array.isArray(plan.checks) || plan.checks.length === 0 || plan.checks.length > 20) {
    throw new Error("pilot_plan_checks_invalid");
  }
  const names = new Set();
  const pilotHosts = new Set();
  const checks = plan.checks.map((check) => {
    if (!SAFE_NAME_PATTERN.test(check?.name ?? "") || names.has(check.name)) throw new Error("pilot_check_name_invalid");
    names.add(check.name);
    if (!new Set(["health", "marketing", "pilot_storefront", "custom_domain"]).has(check.kind)) {
      throw new Error(`pilot_check_kind_invalid:${check.name}`);
    }
    let url;
    try {
      url = new globalThis.URL(check.url);
    } catch {
      throw new Error(`pilot_check_url_invalid:${check.name}`);
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || PLACEHOLDER_PATTERN.test(url.hostname)) {
      throw new Error(`pilot_check_url_invalid:${check.name}`);
    }
    if (!Number.isSafeInteger(check.expectedStatus) || check.expectedStatus < 200 || check.expectedStatus > 399) {
      throw new Error(`pilot_check_status_invalid:${check.name}`);
    }
    if (check.kind === "pilot_storefront") pilotHosts.add(url.hostname);
    const requiredHeaders = Array.isArray(check.requiredHeaders) ? check.requiredHeaders : [];
    if (requiredHeaders.some((name) => !/^[a-z0-9-]{2,80}$/u.test(name))) {
      throw new Error(`pilot_check_header_invalid:${check.name}`);
    }
    if (check.bodyMarker !== undefined && (typeof check.bodyMarker !== "string" || check.bodyMarker.length < 2 || check.bodyMarker.length > 120)) {
      throw new Error(`pilot_check_marker_invalid:${check.name}`);
    }
    return {
      bodyMarker: check.bodyMarker,
      expectedStatus: check.expectedStatus,
      kind: check.kind,
      name: check.name,
      requiredHeaders,
      url: url.toString(),
    };
  });
  if (pilotHosts.size < 2) throw new Error("pilot_plan_two_shop_hosts_required");
  return { checks, environment: "production", releaseId: plan.releaseId };
}

async function readBoundedResponse(response) {
  if (response.body === null) return { body: "", tooLarge: false };
  const reader = response.body.getReader();
  const decoder = new globalThis.TextDecoder();
  let body = "";
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_SMOKE_RESPONSE_BYTES) {
      await reader.cancel();
      return { body: "", tooLarge: true };
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  return { body, tooLarge: false };
}

export async function runPilotSmoke(input) {
  const plan = validatePilotSmokePlan(input.plan);
  if (!input.execute) {
    return {
      actions: plan.checks.map((check) => ({ code: "would_get", name: check.name, ok: true })),
      environment: "production",
      executed: false,
      ok: true,
    };
  }
  if (!input.confirmProduction) throw new Error("pilot_production_confirmation_required");
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const results = [];
  for (const check of plan.checks) {
    let response;
    try {
      response = await fetchImplementation(check.url, {
        method: "GET",
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(10_000),
      });
    } catch {
      results.push({ code: "request_failed", name: check.name, ok: false });
      continue;
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_SMOKE_RESPONSE_BYTES) {
      results.push({ code: "response_too_large", name: check.name, ok: false });
      continue;
    }
    let bounded;
    try {
      bounded = await readBoundedResponse(response);
    } catch {
      results.push({ code: "response_read_failed", name: check.name, ok: false });
      continue;
    }
    if (bounded.tooLarge) {
      results.push({ code: "response_too_large", name: check.name, ok: false });
      continue;
    }
    const statusOk = response.status === check.expectedStatus;
    const headersOk = check.requiredHeaders.every((name) => response.headers.has(name));
    const markerOk = check.bodyMarker === undefined || bounded.body.includes(check.bodyMarker);
    results.push({
      code: statusOk && headersOk && markerOk ? "passed" : "contract_mismatch",
      name: check.name,
      ok: statusOk && headersOk && markerOk,
    });
  }
  return {
    actions: results,
    environment: "production",
    executed: true,
    ok: results.every((result) => result.ok),
  };
}
