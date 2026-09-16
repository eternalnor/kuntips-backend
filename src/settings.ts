// src/settings.ts
// Platform-wide settings stored in KV. Live-editable from the admin panel.

import type { Env } from "./env";

const TIPS_SETTINGS_KEY = "settings:tips";

export type TipsSettings = {
  min_nok: number;
  max_nok: number;
  presets: number[];
};

// Used when KV is empty or unreachable.
export const DEFAULT_TIPS_SETTINGS: TipsSettings = {
  min_nok: 50,
  max_nok: 2000,
  presets: [50, 100, 250, 500, 1000],
};

/**
 * Read tip settings from KV. Returns defaults if missing or malformed.
 * Always returns a valid (sanitised) TipsSettings object.
 */
export async function getTipsSettings(env: Env): Promise<TipsSettings> {
  try {
    const raw = await env.kuntips_rl.get(TIPS_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_TIPS_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<TipsSettings>;
    return sanitize(parsed);
  } catch {
    return { ...DEFAULT_TIPS_SETTINGS };
  }
}

/**
 * Write tip settings to KV. Caller MUST validate input via validate() first.
 */
export async function setTipsSettings(
  env: Env,
  settings: TipsSettings,
): Promise<void> {
  const safe = sanitize(settings);
  await env.kuntips_rl.put(TIPS_SETTINGS_KEY, JSON.stringify(safe));
}

/**
 * Validate user-supplied tip settings before write. Returns null if valid,
 * else an error message describing what's wrong.
 */
export function validateTipsSettings(input: any): string | null {
  if (!input || typeof input !== "object") return "settings must be an object";

  const min = Number(input.min_nok);
  const max = Number(input.max_nok);
  const presets: any = input.presets;

  if (!Number.isFinite(min) || min < 1) {
    return "min_nok must be a positive integer >= 1";
  }
  if (!Number.isFinite(max) || max > 10000) {
    return "max_nok must be <= 10000 NOK";
  }
  if (min >= max) {
    return "min_nok must be strictly less than max_nok";
  }
  if (!Array.isArray(presets) || presets.length < 1 || presets.length > 6) {
    return "presets must be an array of 1-6 numbers";
  }
  for (const p of presets) {
    const n = Number(p);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return "every preset must be an integer NOK amount";
    }
    if (n < min || n > max) {
      return `preset ${n} must be between min_nok (${min}) and max_nok (${max})`;
    }
  }
  // Ensure ascending
  for (let i = 1; i < presets.length; i++) {
    if (Number(presets[i]) <= Number(presets[i - 1])) {
      return "presets must be strictly ascending";
    }
  }

  return null;
}

function sanitize(input: Partial<TipsSettings>): TipsSettings {
  const min = clampInt(input.min_nok, DEFAULT_TIPS_SETTINGS.min_nok, 1, 10000);
  const max = clampInt(
    input.max_nok,
    DEFAULT_TIPS_SETTINGS.max_nok,
    min + 1,
    10000,
  );
  const rawPresets = Array.isArray(input.presets)
    ? input.presets
        .map((p) => Number(p))
        .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max)
    : [];
  const presets =
    rawPresets.length > 0
      ? Array.from(new Set(rawPresets)).sort((a, b) => a - b).slice(0, 6)
      : DEFAULT_TIPS_SETTINGS.presets.filter((p) => p >= min && p <= max);

  return {
    min_nok: min,
    max_nok: max,
    presets: presets.length > 0 ? presets : [min],
  };
}

function clampInt(
  v: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
