import { config } from '../config.js';
import { inspectFloridaSosKey } from './floridaSosKey.js';
import { getSupabase, hasSupabase, ingestSecret } from './supabase.js';

export const SETTING_KEYS = [
  'shovels_api_key',
  'veriphone_api_key',
  'texas_cpa_api_key',
  'florida_sos_api_key',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type KeySource = 'none' | 'env' | 'claude';

type Slot = {
  value: string;
  source: KeySource;
  updated_by: string | null;
  updated_at: string | null;
};

const envFallback: Record<SettingKey, string> = {
  shovels_api_key: config.permitstackApiKey || config.shovelsApiKey,
  veriphone_api_key: config.veriphoneApiKey,
  texas_cpa_api_key: config.texasCpaApiKey,
  florida_sos_api_key: config.floridaSosApiKey,
};

const slots: Record<SettingKey, Slot> = {
  shovels_api_key: emptySlot(envFallback.shovels_api_key),
  veriphone_api_key: emptySlot(envFallback.veriphone_api_key),
  texas_cpa_api_key: emptySlot(envFallback.texas_cpa_api_key),
  florida_sos_api_key: emptySlot(envFallback.florida_sos_api_key),
};

let loadedFromStore = false;

function emptySlot(envValue: string): Slot {
  const value = envValue.trim();
  return {
    value,
    source: value ? 'env' : 'none',
    updated_by: null,
    updated_at: null,
  };
}

function copySlot(slot: Slot): Slot {
  return { ...slot };
}

function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

export function maskKey(key: string): string {
  const t = key.trim();
  if (!t) return '';
  if (t.length <= 8) return '••••';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

/** Next loadAppSettings() re-reads from Supabase. In-memory Claude writes still apply immediately. */
export function invalidateAppSettings(): void {
  loadedFromStore = false;
}

export async function loadAppSettings(opts?: { force?: boolean }): Promise<void> {
  if (loadedFromStore && !opts?.force) return;
  loadedFromStore = true;
  if (!hasSupabase()) {
    for (const key of SETTING_KEYS) slots[key] = emptySlot(envFallback[key]);
    return;
  }
  for (const key of SETTING_KEYS) {
    try {
      const { data, error } = await getSupabase().rpc('fetch_permit_parcel_setting', {
        p_secret: ingestSecret(),
        p_key: key,
      });
      if (error) {
        console.warn(`[app settings] load ${key} failed`, error.message);
        slots[key] = emptySlot(envFallback[key]);
        continue;
      }
      const row = data as {
        found?: boolean;
        value?: string;
        updated_by?: string;
        updated_at?: string;
      } | null;
      if (row?.found && row.value) {
        slots[key] = {
          value: String(row.value).trim(),
          source: 'claude',
          updated_by: row.updated_by ?? null,
          updated_at: row.updated_at ?? null,
        };
        continue;
      }
    } catch (err) {
      console.warn(`[app settings] load ${key} failed`, err);
    }
    slots[key] = emptySlot(envFallback[key]);
  }
}

export function getSetting(key: SettingKey): string {
  return (slots[key].value || envFallback[key] || '').trim();
}

export function settingStatus(key: SettingKey) {
  const slot = slots[key];
  if (key === 'florida_sos_api_key') {
    const raw = (slot.value || envFallback[key] || '').trim();
    const info = inspectFloridaSosKey(raw);
    const envInfo = inspectFloridaSosKey(envFallback[key]);
    const display = info.status === 'malformed' ? raw : info.usable || raw;
    return {
      key,
      configured: Boolean(info.usable),
      source: (info.usable || info.status === 'malformed') ? slot.source : 'none',
      masked: display ? maskKey(display) : null,
      updated_by: slot.updated_by,
      updated_at: slot.updated_at,
      env_fallback: Boolean(envInfo.usable),
      persist_available: hasSupabase(),
      reason: info.reason,
      salvaged: info.salvaged,
    };
  }
  const value = getSetting(key);
  return {
    key,
    configured: Boolean(value),
    source: value ? slot.source : 'none',
    masked: value ? maskKey(value) : null,
    updated_by: slot.updated_by,
    updated_at: slot.updated_at,
    env_fallback: Boolean(envFallback[key]),
    persist_available: hasSupabase(),
  };
}

export async function getSettingStatus(key: SettingKey) {
  await loadAppSettings();
  return settingStatus(key);
}

export async function enrichmentKeysStatus() {
  await loadAppSettings();
  const floridaPersist = await settingRpcAllows('florida_sos_api_key');
  return {
    ok: true,
    permitstack_api_key: settingStatus('shovels_api_key'),
    shovels_api_key: settingStatus('shovels_api_key'),
    veriphone_api_key: settingStatus('veriphone_api_key'),
    texas_cpa_api_key: settingStatus('texas_cpa_api_key'),
    florida_sos_api_key: {
      ...settingStatus('florida_sos_api_key'),
      persist_allowed: floridaPersist,
    },
    assistant_instructions: floridaPersist
      ? 'Show only masked fingerprints. Never echo full keys. Cayden sets missing ones with set_enrichment_api_key. florida_sos_api_key is optional — public Sunbiz HTML is tried first; a Sunbiz Daily sb_ key (the X-API-Key header, not a second secret) is only needed if Cloudflare blocks this host. A pasted curl is configured=false reason=malformed, not a working key.'
      : 'florida_sos_api_key cannot be stored until Josh applies supabase/migrations/20260910_florida_sos_api_key_setting.sql on kemvxzhcxvynmoutwdrh. Do not report the key as saved. Show only masked fingerprints.',
  };
}

async function settingRpcAllows(key: SettingKey): Promise<boolean> {
  if (!hasSupabase()) return false;
  try {
    const { error } = await getSupabase().rpc('fetch_permit_parcel_setting', {
      p_secret: ingestSecret(),
      p_key: key,
    });
    if (!error) return true;
    return !/unknown setting/i.test(error.message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    return !/unknown setting/i.test(msg);
  }
}

async function persistSetting(key: SettingKey, value: string, by: string): Promise<string | null> {
  if (!hasSupabase()) return 'Supabase not configured — cannot persist the key';
  const { error } = await getSupabase().rpc('upsert_permit_parcel_setting', {
    p_secret: ingestSecret(),
    p_key: key,
    p_value: value,
    p_updated_by: by,
  });
  return error ? error.message : null;
}

function canonicalSettingKey(key: string): string {
  if (key === 'permitstack_api_key') return 'shovels_api_key';
  if (key === 'sunbiz_api_key' || key === 'sunbizdaily_api_key' || key === 'sunbizdata_api_key') {
    return 'florida_sos_api_key';
  }
  return key;
}

export async function setAppSetting(opts: {
  key: string;
  api_key: string;
  set_by?: string;
  persist?: boolean;
}): Promise<Record<string, unknown>> {
  await loadAppSettings();
  opts = { ...opts, key: canonicalSettingKey(opts.key) };
  if (!isSettingKey(opts.key)) {
    return { ok: false, error: `Unknown setting. Use: permitstack_api_key, ${SETTING_KEYS.join(', ')}` };
  }
  const by = (opts.set_by || 'cayden').trim().toLowerCase() || 'cayden';
  let value = opts.api_key.trim();
  let salvaged = false;
  if (opts.key === 'florida_sos_api_key') {
    const info = inspectFloridaSosKey(value);
    if (info.status === 'malformed' || info.status === 'missing') {
      return {
        ok: false,
        error:
          'florida_sos_api_key is malformed — paste the Sunbiz Daily sb_ token (that value is the X-API-Key header), not a curl command.',
        reason: 'malformed',
      };
    }
    if (info.status === 'salvaged') {
      value = info.usable;
      salvaged = true;
    }
  }
  if (value.length < 8) return { ok: false, error: 'API key looks too short' };
  const previous = copySlot(slots[opts.key]);
  const written: Slot = {
    value,
    source: 'claude',
    updated_by: by,
    updated_at: new Date().toISOString(),
  };
  slots[opts.key] = written;
  if (opts.persist === false) {
    return {
      ok: true,
      ...settingStatus(opts.key),
      salvaged,
      persisted: false,
      persist_error: null,
      assistant_instructions:
        'Key is in memory only (persist=false). Never repeat the full key. Show only the masked fingerprint.',
    };
  }
  const persistError = await persistSetting(opts.key, value, by);
  if (persistError) {
    slots[opts.key] = previous;
    return {
      ok: false,
      error: `Could not persist ${opts.key}: ${persistError}`,
      persist_error: persistError,
      persisted: false,
      ...settingStatus(opts.key),
      assistant_instructions:
        persistError.includes('unknown setting')
          ? `Postgres rejected ${opts.key}. Apply supabase/migrations/20260910_florida_sos_api_key_setting.sql on kemvxzhcxvynmoutwdrh, then retry set_enrichment_api_key. Do not claim the key is saved.`
          : `Could not persist ${opts.key}. The previous value is still in effect. Never echo the full key.`,
    };
  }
  return {
    ok: true,
    ...settingStatus(opts.key),
    salvaged,
    persisted: true,
    persist_error: null,
    assistant_instructions:
      'Key is set and stored. Never repeat the full key. Show only the masked fingerprint. match_florida_officers / lookup_line_type can use it on the next call — no Railway restart.',
  };
}

export async function clearAppSetting(opts: {
  key: string;
  set_by?: string;
}): Promise<Record<string, unknown>> {
  await loadAppSettings();
  opts = { ...opts, key: canonicalSettingKey(opts.key) };
  if (!isSettingKey(opts.key)) {
    return { ok: false, error: `Unknown setting. Use: permitstack_api_key, ${SETTING_KEYS.join(', ')}` };
  }
  const by = (opts.set_by || 'cayden').trim().toLowerCase() || 'cayden';
  const previous = copySlot(slots[opts.key]);
  slots[opts.key] = {
    ...emptySlot(envFallback[opts.key]),
    updated_by: by,
    updated_at: new Date().toISOString(),
  };
  if (hasSupabase()) {
    const persistError = await persistSetting(opts.key, '', by);
    if (persistError) {
      slots[opts.key] = previous;
      return {
        ok: false,
        error: `Could not clear ${opts.key}: ${persistError}`,
        persist_error: persistError,
        ...settingStatus(opts.key),
      };
    }
  }
  return {
    ok: true,
    ...settingStatus(opts.key),
    note: envFallback[opts.key] ? 'Reverted to env fallback' : 'No key configured',
  };
}
