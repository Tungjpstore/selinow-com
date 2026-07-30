import type { AppBindings } from "../platform/bindings";

const REAL_TURNSTILE_KEY = /^0x[A-Za-z0-9_-]{20,}$/u;
const TEST_SITE_KEYS = new Set([
  "1x00000000000000000000AA",
  "1x00000000000000000000BB",
  "2x00000000000000000000AB",
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
]);
const TEST_SECRET_KEYS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

type TurnstileBindings = Pick<AppBindings, "APP_ENV" | "TURNSTILE_SECRET_KEY" | "TURNSTILE_SITE_KEY">;

export type TurnstileConfiguration = {
  secretKey: string;
  siteKey: string;
};

export function resolveTurnstileConfiguration(env: TurnstileBindings): TurnstileConfiguration | null {
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  if (!secretKey || !siteKey) return null;

  if (REAL_TURNSTILE_KEY.test(siteKey) && REAL_TURNSTILE_KEY.test(secretKey)) return { secretKey, siteKey };
  if (env.APP_ENV === "local" && TEST_SITE_KEYS.has(siteKey) && TEST_SECRET_KEYS.has(secretKey)) return { secretKey, siteKey };
  return null;
}
