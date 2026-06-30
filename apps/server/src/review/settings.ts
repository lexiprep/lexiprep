// Per-user settings for the card-review game (spec 12). The first settings surface in the
// app: lazy — a row is created on first write, reads fall back to the column defaults so an
// untouched user needs no row. Validates the timezone (must be a real IANA zone) and clamps
// the per-day budgets to sane bounds before persisting.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { userSettings, type NewUserSettings } from "../db/schema.js";

/** The settings shape returned to clients (`GET|PUT /api/settings`). */
export interface Settings {
  newPerDay: number;
  maxPerDay: number;
  autoGraduateKnown: boolean;
  timezone: string | null;
}

/** A partial update; only provided fields change. `timezone: null` clears it (→ UTC). */
export interface SettingsPatch {
  newPerDay?: number;
  maxPerDay?: number;
  autoGraduateKnown?: boolean;
  timezone?: string | null;
}

/** Column defaults, mirrored here so a read needs no row (spec 12 §user_settings). */
export const DEFAULT_SETTINGS: Settings = {
  newPerDay: 20,
  maxPerDay: 200,
  autoGraduateKnown: false,
  timezone: null,
};

/** Thrown for a rejected patch (e.g. an unknown timezone); the route maps it to 400. */
export class SettingsError extends Error {}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** True when `tz` names a real IANA zone (the only thing `Intl` accepts without throwing). */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The user's settings, or the defaults when no row exists yet (no write on read). */
export async function getSettings(userId: string): Promise<Settings> {
  const [row] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    newPerDay: row.newPerDay,
    maxPerDay: row.maxPerDay,
    autoGraduateKnown: row.autoGraduateKnown,
    timezone: row.timezone,
  };
}

/**
 * Apply a partial update and return the full, current settings. Creates the row on first
 * write (`onConflictDoUpdate` on the user). Clamps `newPerDay` to [0,1000] and `maxPerDay`
 * to [1,1000]; validates `timezone` (an empty string is treated as null → clear).
 */
export async function upsertSettings(userId: string, patch: SettingsPatch): Promise<Settings> {
  const set: Partial<NewUserSettings> = {};
  if (patch.newPerDay !== undefined) set.newPerDay = clamp(patch.newPerDay, 0, 1000);
  if (patch.maxPerDay !== undefined) set.maxPerDay = clamp(patch.maxPerDay, 1, 1000);
  if (patch.autoGraduateKnown !== undefined) set.autoGraduateKnown = patch.autoGraduateKnown;
  if (patch.timezone !== undefined) {
    const tz = patch.timezone === "" ? null : patch.timezone;
    if (tz !== null && !isValidTimezone(tz)) {
      throw new SettingsError(`Unknown timezone: ${patch.timezone}`);
    }
    set.timezone = tz;
  }

  // An empty patch never writes — just return the current settings (an empty DO UPDATE SET
  // is also invalid SQL, so guarding here is correct as well as cheap).
  if (Object.keys(set).length > 0) {
    await db
      .insert(userSettings)
      .values({ userId, ...set })
      .onConflictDoUpdate({ target: userSettings.userId, set });
  }
  return getSettings(userId);
}
