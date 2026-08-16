import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";

export type BookingSlot = {
  endAt: string;
  resourceId: string;
  resourceName: string;
  startAt: string;
};

export type BookingSelection = {
  endAt: string;
  resourceId: string;
  startAt: string;
  variantId: string;
};

type ScheduleRow = {
  endMinute: number;
  resourceId: string;
  startMinute: number;
  weekday: number;
};

type ResourceRow = { id: string; name: string; roleLabel: string | null };

const SLOT_RANGE_MAX_DAYS = 14;
const ISO_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:00(\.\d{3})?)?Z$/u;

/** Offset (ms) of the shop timezone at the given UTC instant. */
function timezoneOffsetMs(timeZone: string, at: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "numeric", second: "numeric", timeZone, hour12: false });
  const parts = formatter.formatToParts(at);
  const read = (type: string): number => Number.parseInt(parts.find((part) => part.type === type)?.value ?? "0", 10);
  const asUtc = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds());
  const shifted = (read("hour") % 24) * 3_600_000 + read("minute") * 60_000 + read("second") * 1_000;
  return shifted - (asUtc % 86_400_000);
}

/** Local (shop tz) calendar key and minute-of-day for a UTC instant. */
function localDayKey(timeZone: string, at: Date): { day: string; minuteOfDay: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", weekday: "short", year: "numeric", timeZone, hour12: false });
  const parts = formatter.formatToParts(at);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone, hour12: false }).format(at).split(":");
  return {
    day: `${read("year")}-${read("month")}-${read("day")}`,
    minuteOfDay: Number(time[0] ?? "0") * 60 + Number(time[1] ?? "0"),
    weekday: weekdays[read("weekday")] ?? 0,
  };
}

/** UTC instant for a local day + minute using the two-probe offset trick. */
function zonedMinuteToUtc(timeZone: string, day: string, minuteOfDay: number): Date {
  const year = Number.parseInt(day.slice(0, 4), 10);
  const month = Number.parseInt(day.slice(5, 7), 10);
  const date = Number.parseInt(day.slice(8, 10), 10);
  const naive = Date.UTC(year, month - 1, date, 0, minuteOfDay, 0);
  const offsetFirst = timezoneOffsetMs(timeZone, new Date(naive));
  const offsetSecond = timezoneOffsetMs(timeZone, new Date(naive - offsetFirst));
  return new Date(naive - offsetSecond);
}

async function loadServiceVariant(env: AppBindings, shopId: string, variantId: string): Promise<{ durationMinutes: number; productId: string }> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT product_variants.product_id AS productId, product_variants.duration_minutes AS durationMinutes
    FROM product_variants
    INNER JOIN products ON products.shop_id = product_variants.shop_id AND products.id = product_variants.product_id
    WHERE product_variants.shop_id = ? AND product_variants.id = ?
      AND product_variants.status = 'active' AND products.status = 'active'
      AND product_variants.duration_minutes IS NOT NULL
    LIMIT 1
  `).bind(shopId, variantId).first<{ durationMinutes: number; productId: string }>();
  if (row === null) throw new AppError("booking_service_not_found", 404);
  return row;
}

async function loadScheduleContext(env: AppBindings, shopId: string): Promise<{ resources: Map<string, ResourceRow>; schedules: ScheduleRow[] }> {
  const [resourceRows, scheduleRows] = await Promise.all([
    env.PLATFORM_DB.prepare("SELECT id, name, role_label AS roleLabel FROM booking_resources WHERE shop_id = ? AND status = 'active' ORDER BY name, id LIMIT 50").bind(shopId).all<ResourceRow>(),
    env.PLATFORM_DB.prepare("SELECT resource_id AS resourceId, weekday, start_minute AS startMinute, end_minute AS endMinute FROM booking_resource_schedules WHERE shop_id = ? AND status = 'active' ORDER BY resource_id, weekday, start_minute LIMIT 500").bind(shopId).all<ScheduleRow>(),
  ]);
  return { resources: new Map(resourceRows.results.map((row) => [row.id, row])), schedules: scheduleRows.results };
}

async function loadBusyIntervals(env: AppBindings, shopId: string, windowStartIso: string, windowEndIso: string): Promise<Array<{ endAt: string; resourceId: string; startAt: string }>> {
  const [holds, bookings] = await Promise.all([
    env.PLATFORM_DB.prepare(`
      SELECT resource_id AS resourceId, start_at AS startAt, end_at AS endAt
      FROM booking_holds
      WHERE shop_id = ? AND status = 'active' AND start_at < ? AND end_at > ?
      LIMIT 500
    `).bind(shopId, windowEndIso, windowStartIso).all<{ endAt: string; resourceId: string; startAt: string }>(),
    env.PLATFORM_DB.prepare(`
      SELECT resource_id AS resourceId, start_at AS startAt, end_at AS endAt
      FROM bookings
      WHERE shop_id = ? AND status = 'booked' AND start_at < ? AND end_at > ?
      LIMIT 500
    `).bind(shopId, windowEndIso, windowStartIso).all<{ endAt: string; resourceId: string; startAt: string }>(),
  ]);
  return [...holds.results, ...bookings.results];
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

/**
 * Compute bookable slots for a service variant across a local-day window.
 * Slots step by the service duration inside each schedule window and drop
 * anything overlapping an active hold or a booked appointment.
 */
export async function listBookingSlots(input: {
  dateStart: string;
  dateEnd: string;
  env: AppBindings;
  shop: { id: string; timezone: string };
  variantId: string;
}): Promise<BookingSlot[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.dateStart) || !/^\d{4}-\d{2}-\d{2}$/u.test(input.dateEnd)) {
    throw new AppError("validation_failed", 400, ["booking_date_invalid"]);
  }
  const startDay = Date.parse(`${input.dateStart}T00:00:00Z`);
  const endDay = Date.parse(`${input.dateEnd}T00:00:00Z`);
  if (!Number.isFinite(startDay) || !Number.isFinite(endDay) || endDay < startDay || (endDay - startDay) / 86_400_000 > SLOT_RANGE_MAX_DAYS) {
    throw new AppError("validation_failed", 400, ["booking_date_invalid"]);
  }
  const service = await loadServiceVariant(input.env, input.shop.id, input.variantId);
  const { resources, schedules } = await loadScheduleContext(input.env, input.shop.id);
  const windowStart = zonedMinuteToUtc(input.shop.timezone, input.dateStart, 0);
  const windowEnd = zonedMinuteToUtc(input.shop.timezone, input.dateEnd, 24 * 60 - 1);
  const busy = await loadBusyIntervals(input.env, input.shop.id, windowStart.toISOString(), windowEnd.toISOString());
  const slots: BookingSlot[] = [];
  const dayCount = Math.round((endDay - startDay) / 86_400_000) + 1;
  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const day = new Date(startDay + dayIndex * 86_400_000).toISOString().slice(0, 10);
    // Any instant inside the local day reports that day's weekday; noon is
    // safely inside it for every timezone offset.
    const weekday = localDayKey(input.shop.timezone, zonedMinuteToUtc(input.shop.timezone, day, 720)).weekday;
    for (const schedule of schedules) {
      if (schedule.weekday !== weekday) continue;
      const resource = resources.get(schedule.resourceId);
      if (resource === undefined) continue;
      for (let minute = schedule.startMinute; minute + service.durationMinutes <= schedule.endMinute; minute += service.durationMinutes) {
        const startAt = zonedMinuteToUtc(input.shop.timezone, day, minute);
        const endAt = new Date(startAt.getTime() + service.durationMinutes * 60_000);
        const startMs = startAt.getTime();
        const endMs = endAt.getTime();
        if (startMs < Date.now()) continue;
        const conflict = busy.some((entry) => entry.resourceId === schedule.resourceId && overlaps(startMs, endMs, Date.parse(entry.startAt), Date.parse(entry.endAt)));
        if (conflict) continue;
        slots.push({ endAt: endAt.toISOString(), resourceId: schedule.resourceId, resourceName: resource.name, startAt: startAt.toISOString() });
      }
    }
  }
  slots.sort((left, right) => left.startAt.localeCompare(right.startAt) || left.resourceId.localeCompare(right.resourceId));
  return slots.slice(0, 200);
}

/**
 * Resolve and re-validate one buyer-selected slot for checkout. The canonical
 * transaction re-checks overlap atomically; this pass gives fast feedback.
 */
export async function resolveBookingSelection(input: {
  env: AppBindings;
  resourceId: string;
  shop: { id: string; timezone: string };
  startAt: string;
  variantId: string;
}): Promise<BookingSelection> {
  if (typeof input.startAt !== "string" || !ISO_MINUTE.test(input.startAt)) {
    throw new AppError("validation_failed", 400, ["booking_slot_invalid"]);
  }
  if (typeof input.resourceId !== "string" || !/^[a-z0-9_][a-z0-9_:-]{2,63}$/u.test(input.resourceId)) {
    throw new AppError("validation_failed", 400, ["booking_slot_invalid"]);
  }
  const service = await loadServiceVariant(input.env, input.shop.id, input.variantId);
  const startMs = Date.parse(input.startAt);
  if (!Number.isFinite(startMs) || startMs <= Date.now()) {
    throw new AppError("validation_failed", 400, ["booking_slot_invalid"]);
  }
  const endAt = new Date(startMs + service.durationMinutes * 60_000).toISOString();
  const local = localDayKey(input.shop.timezone, new Date(startMs));
  const localEndMinute = local.minuteOfDay + service.durationMinutes;
  // The slot must sit fully inside one active schedule window on its weekday.
  const schedule = await input.env.PLATFORM_DB.prepare(`
    SELECT 1
    FROM booking_resource_schedules
    WHERE shop_id = ? AND resource_id = ? AND status = 'active' AND weekday = ?
      AND start_minute <= ? AND end_minute >= ?
    LIMIT 1
  `).bind(input.shop.id, input.resourceId, local.weekday, local.minuteOfDay, localEndMinute).first();
  if (schedule === null) throw new AppError("booking_slot_invalid", 404);
  const busy = await loadBusyIntervals(input.env, input.shop.id, input.startAt, endAt);
  if (busy.some((entry) => entry.resourceId === input.resourceId && overlaps(startMs, Date.parse(endAt), Date.parse(entry.startAt), Date.parse(entry.endAt)))) {
    throw new AppError("booking_slot_taken", 409);
  }
  return { endAt, resourceId: input.resourceId, startAt: input.startAt, variantId: input.variantId };
}

/** Seller-side: create a bookable resource (staff or room). */
export async function createBookingResource(input: {
  data: Record<string, unknown>;
  env: AppBindings;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<ResourceRow & { status: string }> {
  const member = await getShopForMember({ capability: "catalog:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const name = input.data.name;
  const roleLabel = input.data.roleLabel ?? null;
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 80) throw new AppError("validation_failed", 400, ["booking_resource_name_invalid"]);
  if (roleLabel !== null && (typeof roleLabel !== "string" || roleLabel.trim().length < 2 || roleLabel.trim().length > 80)) throw new AppError("validation_failed", 400, ["booking_resource_role_invalid"]);
  const id = createId("brs");
  const nowIso = new Date().toISOString();
  const inserted = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO booking_resources (id, shop_id, name, role_label, status, created_at, updated_at)
    SELECT ?, ?, ?, ?, 'active', ?, ?
    FROM shops WHERE id = ? AND status IN ('draft', 'active')
    RETURNING id, name, role_label AS roleLabel, status
  `).bind(id, member.row.shop_id, name.trim(), roleLabel === null ? null : roleLabel.trim(), nowIso, nowIso, member.row.shop_id).first<ResourceRow & { status: string }>();
  if (inserted === null) throw new AppError("shop_inactive", 409);
  return inserted;
}

/** Seller-side: set one weekly availability window for a resource. */
export async function upsertBookingSchedule(input: {
  data: Record<string, unknown>;
  env: AppBindings;
  requestId: string;
  resourceId: string;
  shopPublicId: string;
  userId: string;
}): Promise<{ id: string }> {
  const member = await getShopForMember({ capability: "catalog:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const weekdayRaw = input.data.weekday;
  const startMinuteRaw = input.data.startMinute;
  const endMinuteRaw = input.data.endMinute;
  if (typeof weekdayRaw !== "number" || typeof startMinuteRaw !== "number" || typeof endMinuteRaw !== "number"
    || !Number.isSafeInteger(weekdayRaw) || weekdayRaw < 0 || weekdayRaw > 6
    || !Number.isSafeInteger(startMinuteRaw) || startMinuteRaw < 0 || startMinuteRaw >= 1440
    || !Number.isSafeInteger(endMinuteRaw) || endMinuteRaw <= startMinuteRaw || endMinuteRaw > 1440) {
    throw new AppError("validation_failed", 400, ["booking_schedule_invalid"]);
  }
  const weekday = weekdayRaw;
  const startMinute = startMinuteRaw;
  const endMinute = endMinuteRaw;
  const id = createId("bsd");
  const nowIso = new Date().toISOString();
  const inserted = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO booking_resource_schedules (id, shop_id, resource_id, weekday, start_minute, end_minute, status, created_at, updated_at)
    SELECT ?, ?, resource.id, ?, ?, ?, 'active', ?, ?
    FROM booking_resources AS resource
    WHERE resource.shop_id = ? AND resource.id = ? AND resource.status = 'active'
    RETURNING id
  `).bind(id, member.row.shop_id, weekday, startMinute, endMinute, nowIso, nowIso, member.row.shop_id, input.resourceId).first<{ id: string }>();
  if (inserted === null) throw new AppError("resource_not_found", 404);
  return inserted;
}
