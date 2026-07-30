import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";
import type {
  OnboardingChannelsInput,
  OnboardingSettingsInput,
  OnboardingStepCode,
} from "./policy";

type OnboardingProfileRow = {
  createdAt: string;
  currentStep: OnboardingStepCode;
  customDomainPreference: "connect" | "later" | "skip";
  telegramEnabled: number;
  updatedAt: string;
  version: number;
  websiteEnabled: number;
};

type OnboardingStepRow = {
  blockingCode: string | null;
  completedAt: string | null;
  lastCheckedAt: string | null;
  startedAt: string | null;
  status: "blocked" | "complete" | "in_progress" | "pending" | "skipped";
  stepCode: OnboardingStepCode;
  updatedAt: string;
  version: number;
};

type OnboardingSettingsRow = {
  attestedAt: string | null;
  attestationVersion: number | null;
  privacyUrl: string | null;
  refundPolicyUrl: string | null;
  supportContact: string | null;
  termsUrl: string | null;
  version: number;
};

export type OnboardingProfile = {
  createdAt: string;
  currentStep: OnboardingStepCode;
  customDomainPreference: "connect" | "later" | "skip";
  telegramEnabled: boolean;
  updatedAt: string;
  version: number;
  websiteEnabled: boolean;
};

export type OnboardingStep = Omit<OnboardingStepRow, "stepCode"> & { code: OnboardingStepCode };

export type OnboardingSettings = {
  attestationAccepted: boolean;
  attestationVersion: number | null;
  attestedAt: string | null;
  privacyUrl: string | null;
  refundPolicyUrl: string | null;
  supportContact: string | null;
  termsUrl: string | null;
  version: number;
};

export type OnboardingState = {
  profile: OnboardingProfile;
  settings: OnboardingSettings;
  steps: OnboardingStep[];
};

async function requireOwner(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<{ shopId: string }> {
  const actor = await getShopForMember({
    capability: "shop:update",
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  if (actor.row.role !== "owner") {
    throw new AppError("authorization_denied", 403);
  }
  return { shopId: actor.row.shop_id };
}

async function readOnboardingState(env: AppBindings, shopId: string): Promise<OnboardingState> {
  const [profile, settings, steps] = await Promise.all([
    env.PLATFORM_DB.prepare(`
      SELECT
        website_enabled AS websiteEnabled,
        telegram_enabled AS telegramEnabled,
        custom_domain_preference AS customDomainPreference,
        current_step AS currentStep,
        version,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM shop_onboarding_profiles
      WHERE shop_id = ?
      LIMIT 1
    `).bind(shopId).first<OnboardingProfileRow>(),
    env.PLATFORM_DB.prepare(`
      SELECT
        support_contact AS supportContact,
        terms_url AS termsUrl,
        privacy_url AS privacyUrl,
        refund_policy_url AS refundPolicyUrl,
        policy_attestation_version AS attestationVersion,
        policy_attested_at AS attestedAt,
        version
      FROM shop_settings
      WHERE shop_id = ?
      LIMIT 1
    `).bind(shopId).first<OnboardingSettingsRow>(),
    env.PLATFORM_DB.prepare(`
      SELECT
        step_code AS stepCode,
        status,
        version,
        started_at AS startedAt,
        completed_at AS completedAt,
        last_checked_at AS lastCheckedAt,
        blocking_code AS blockingCode,
        updated_at AS updatedAt
      FROM shop_onboarding_steps
      WHERE shop_id = ?
      ORDER BY CASE step_code
        WHEN 'account_ready' THEN 1
        WHEN 'shop_created' THEN 2
        WHEN 'channel_selected' THEN 3
        WHEN 'catalog_ready' THEN 4
        WHEN 'inventory_ready' THEN 5
        WHEN 'telegram_ready' THEN 6
        WHEN 'payos_ready' THEN 7
        WHEN 'domain_ready' THEN 8
        WHEN 'readiness_passed' THEN 9
        WHEN 'published' THEN 10
      END
    `).bind(shopId).all<OnboardingStepRow>(),
  ]);

  if (profile === null || settings === null || steps.results.length === 0) {
    throw new AppError("onboarding_not_initialized", 409);
  }

  return {
    profile: {
      ...profile,
      telegramEnabled: profile.telegramEnabled === 1,
      websiteEnabled: profile.websiteEnabled === 1,
    },
    settings: {
      attestationAccepted: settings.attestedAt !== null && settings.attestationVersion !== null,
      attestationVersion: settings.attestationVersion,
      attestedAt: settings.attestedAt,
      privacyUrl: settings.privacyUrl,
      refundPolicyUrl: settings.refundPolicyUrl,
      supportContact: settings.supportContact,
      termsUrl: settings.termsUrl,
      version: settings.version,
    },
    steps: steps.results.map((step) => ({
      blockingCode: step.blockingCode,
      code: step.stepCode,
      completedAt: step.completedAt,
      lastCheckedAt: step.lastCheckedAt,
      startedAt: step.startedAt,
      status: step.status,
      updatedAt: step.updatedAt,
      version: step.version,
    })),
  };
}

export async function getOnboardingState(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<OnboardingState> {
  const actor = await requireOwner(input);
  return readOnboardingState(input.env, actor.shopId);
}

export async function updateOnboardingChannels(input: {
  channels: OnboardingChannelsInput;
  env: AppBindings;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<OnboardingState> {
  const member = await getShopForMember({
    capability: "shop:update",
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  if (member.row.role !== "owner") throw new AppError("authorization_denied", 403);
  if (input.channels.websiteEnabled && member.shop.featureFlags.storefront !== true) {
    throw new AppError("feature_not_available", 402, ["storefront_not_in_plan"]);
  }
  if (input.channels.telegramEnabled && member.shop.featureFlags.telegram !== true) {
    throw new AppError("feature_not_available", 402, ["telegram_not_in_plan"]);
  }
  if (input.channels.customDomainPreference === "connect" && member.shop.featureFlags.customDomain !== true) {
    throw new AppError("feature_not_available", 402, ["custom_domain_not_in_plan"]);
  }

  const now = new Date().toISOString();
  const auditId = createId("aud");
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) VALUES (?, ?, 'user', ?, 'onboarding.channels_updated', 'shop', ?, ?, ?, ?)
    `).bind(
      auditId,
      member.row.shop_id,
      input.userId,
      member.row.shop_id,
      JSON.stringify({
        customDomainPreference: input.channels.customDomainPreference,
        telegramEnabled: input.channels.telegramEnabled,
        websiteEnabled: input.channels.websiteEnabled,
      }),
      input.requestId,
      now,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_onboarding_profiles
      SET website_enabled = ?,
          telegram_enabled = ?,
          custom_domain_preference = ?,
          current_step = CASE
            WHEN current_step IN ('account_ready', 'shop_created') THEN 'channel_selected'
            ELSE current_step
          END,
          version = version + 1,
          updated_at = ?
      WHERE shop_id = ?
    `).bind(
      input.channels.websiteEnabled ? 1 : 0,
      input.channels.telegramEnabled ? 1 : 0,
      input.channels.customDomainPreference,
      now,
      member.row.shop_id,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_onboarding_steps
      SET status = 'complete',
          started_at = COALESCE(started_at, ?),
          completed_at = ?,
          last_checked_at = ?,
          blocking_code = NULL,
          audit_log_id = ?,
          version = version + 1,
          updated_at = ?
      WHERE shop_id = ? AND step_code = 'channel_selected'
    `).bind(now, now, now, auditId, now, member.row.shop_id),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_onboarding_steps
      SET status = CASE
            WHEN ? = 0 THEN 'skipped'
            WHEN status = 'skipped' THEN 'pending'
            ELSE status
          END,
          completed_at = CASE WHEN ? = 0 THEN ? ELSE completed_at END,
          blocking_code = NULL,
          version = version + 1,
          updated_at = ?
      WHERE shop_id = ? AND step_code = 'telegram_ready'
    `).bind(
      input.channels.telegramEnabled ? 1 : 0,
      input.channels.telegramEnabled ? 1 : 0,
      now,
      now,
      member.row.shop_id,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shops
      SET readiness_version = readiness_version + 1, updated_at = ?
      WHERE id = ? AND public_id = ?
    `).bind(now, member.row.shop_id, input.shopPublicId),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1 || (results[4]?.meta.changes ?? 0) !== 1) {
    throw new AppError("onboarding_not_initialized", 409);
  }
  return readOnboardingState(input.env, member.row.shop_id);
}

export async function updateOnboardingSettings(input: {
  env: AppBindings;
  requestId: string;
  settings: OnboardingSettingsInput;
  shopPublicId: string;
  userId: string;
}): Promise<OnboardingState> {
  const actor = await requireOwner(input);
  const now = new Date().toISOString();
  const auditId = createId("aud");
  const result = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_settings
      SET support_contact = ?,
          terms_url = ?,
          privacy_url = ?,
          refund_policy_url = ?,
          policy_attestation_version = ?,
          policy_attested_at = ?,
          policy_attested_by_user_id = ?,
          version = version + 1,
          updated_at = ?
      WHERE shop_id = ?
    `).bind(
      input.settings.supportContact,
      input.settings.termsUrl,
      input.settings.privacyUrl,
      input.settings.refundPolicyUrl,
      input.settings.attestationVersion,
      input.settings.attestationAccepted ? now : null,
      input.settings.attestationAccepted ? input.userId : null,
      now,
      actor.shopId,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE shops
      SET readiness_version = readiness_version + 1, updated_at = ?
      WHERE id = ? AND public_id = ?
    `).bind(now, actor.shopId, input.shopPublicId),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) VALUES (?, ?, 'user', ?, 'onboarding.settings_updated', 'shop_settings', ?, ?, ?, ?)
    `).bind(
      auditId,
      actor.shopId,
      input.userId,
      actor.shopId,
      JSON.stringify({
        attestationVersion: input.settings.attestationVersion,
        policiesConfigured: input.settings.termsUrl !== null
          && input.settings.privacyUrl !== null
          && input.settings.refundPolicyUrl !== null,
        supportConfigured: input.settings.supportContact !== null,
      }),
      input.requestId,
      now,
    ),
  ]);
  if ((result[0]?.meta.changes ?? 0) !== 1 || (result[1]?.meta.changes ?? 0) !== 1) {
    throw new AppError("authorization_denied", 403);
  }
  return readOnboardingState(input.env, actor.shopId);
}
