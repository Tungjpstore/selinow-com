import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession } from "../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { readJsonObject } from "../../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";
import { getTelegramIntegration, updateTelegramMenuConfig } from "../../../../../../../lib/telegram/integrations";
import type { TelegramTemplatePreset } from "../../../../../../../lib/telegram/types";
import { AppError } from "../../../../../../../lib/core/errors";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const integration = await getTelegramIntegration({
      env,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    if (integration === null) throw new AppError("telegram_not_configured", 404);

    return Response.json(
      {
        menuConfig: {
          menuConfigJson: integration.menuConfigJson,
          supportHandle: integration.supportHandle,
          templatePreset: integration.templatePreset,
          welcomeMessageCustom: integration.welcomeMessageCustom,
        },
        ok: true,
        requestId: locals.requestId,
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } }
    );
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);

    const templatePreset = body.templatePreset as TelegramTemplatePreset;
    const welcomeMessageCustom = typeof body.welcomeMessageCustom === "string" ? body.welcomeMessageCustom.trim().slice(0, 500) : null;
    const supportHandle = typeof body.supportHandle === "string" ? body.supportHandle.trim().slice(0, 60) : null;
    const menuConfigJson = typeof body.menuConfigJson === "string" ? body.menuConfigJson.trim().slice(0, 2000) : null;

    const integration = await updateTelegramMenuConfig({
      env,
      menuConfigJson,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      supportHandle,
      templatePreset,
      userId: auth.userId,
      welcomeMessageCustom,
    });

    return Response.json(
      {
        integration,
        ok: true,
        requestId: locals.requestId,
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } }
    );
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
