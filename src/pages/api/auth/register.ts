import type { APIRoute } from "astro";

import { AppError, isAppError } from "../../../lib/core/errors";
import { claimOtpAdmission, cloudflareRequesterAddress } from "../../../lib/auth/admission";
import { normalizeEmail, normalizeDisplayName, validatePasswordStrength } from "../../../lib/auth/policy";
import { createAndSendOtp } from "../../../lib/auth/otp";
import { hashPassword } from "../../../lib/core/crypto";
import { createId } from "../../../lib/core/ids";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import { readJsonObject, rejectUnknownFields } from "../../../lib/http/request";
import { loggerFor } from "../../../lib/operations/logger";

export const POST: APIRoute = async ({ locals, request }) => {
  const env = getBindings();
  try {
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["email", "password", "displayName"]);

    const email = normalizeEmail(body.email);
    const displayName = normalizeDisplayName(body.displayName, email);
    const password = validatePasswordStrength(body.password);

    await claimOtpAdmission({
      email,
      env,
      now: new Date(),
      purpose: "register_verify",
      requesterAddress: cloudflareRequesterAddress(request),
    });

    // Hash password
    const passwordHash = await hashPassword(password);
    const nowIso = new Date().toISOString();

    // Check if user exists
    const existingUser = await env.PLATFORM_DB.prepare(`
      SELECT id, status, password_hash FROM platform_users WHERE email_normalized = ? LIMIT 1
    `).bind(email).first<{ id: string; password_hash: string | null; status: string }>();

    let userId: string;

    if (existingUser) {
      if (existingUser.status === "suspended") {
        throw new AppError("authentication_required", 401);
      }
      if (existingUser.status === "active" && existingUser.password_hash !== null) {
        throw new AppError("email_exists", 409, ["email_already_registered"]);
      }
      // If user exists but is pending OR has no password (migrated from magic-link), update password and send verification OTP
      userId = existingUser.id;
      const passwordColumn = existingUser.status === "active" && existingUser.password_hash === null
        ? "pending_password_hash"
        : "password_hash";
      await env.PLATFORM_DB.prepare(`
        UPDATE platform_users
        SET display_name = COALESCE(?, display_name), ${passwordColumn} = ?, updated_at = ?
        WHERE id = ?
      `).bind(displayName, passwordHash, nowIso, userId).run();
    } else {
      userId = createId("usr");
      await env.PLATFORM_DB.prepare(`
        INSERT INTO platform_users (
          id, email_normalized, display_name, status, created_at, updated_at, password_hash
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
      `).bind(
        userId,
        email,
        displayName,
        nowIso,
        nowIso,
        passwordHash,
      ).run();
    }


    // Generate & send OTP
    const otpResult = await createAndSendOtp({
      email,
      env,
      locale: locals.locale,
      purpose: "register_verify",
      userId,
    });

    return Response.json({
      cooldownSeconds: otpResult.cooldownSeconds,
      ...(otpResult.debugOtp ? { debugOtp: otpResult.debugOtp } : {}),
      email,
      expiresAt: otpResult.expiresAt,
      message: "Registration initialized. Please enter the OTP sent to your email.",
      ok: true,
      requestId: locals.requestId,
      requireOtp: true,
      userId,
    }, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow",
      },
      status: 201,
    });
  } catch (error) {
    const failure = isAppError(error)
      ? { errorCode: error.code, status: error.status }
      : { errorCode: "internal_error", status: 500 };

    loggerFor(env).warn({
      ...failure,
      event: "auth.register_failed",
      requestId: locals.requestId,
      source: "http",
    });

    return createCaughtErrorResponse(error, locals.requestId);
  }
};
