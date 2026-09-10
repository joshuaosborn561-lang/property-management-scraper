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

function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

export function maskKey(key: string): string {
  const t = key.trim();
  if (!t) return '';
  if (t.length <= 8) return '••••';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

export async function loadAppSettings(): Promise<void> {
  if (loadedFromStore) return;
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
  return {
    ok: true,
    permitstack_api_key: settingStatus('shovels_api_key'),
    shovels_api_key: settingStatus('shovels_api_key'),
    veriphone_api_key: settingStatus('veriphone_api_key'),
    texas_cpa_api_key: settingStatus('texas_cpa_api_key'),
    florida_sos_api_key: settingStatus('florida_sos_api_key'),
    assistant_instructions:
      'Show only masked fingerprints. Never echo full keys. Cayden sets missing ones with set_enrichment_api_key. florida_sos_api_key is optional — public Sunbiz HTML is tried first; a Sunbiz Daily (free) or sunbizdata (sb_) key is only needed if Cloudflare blocks this host. A pasted curl is configured=false reason=malformed, not a working key.',
  };
}

async function persistSetting(key: SettingKey, value: string, by: string): Promise<string | null> {
  if (!hasSupabase()) return 'Supabase not configured — key is in memory only until restart';
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
          'florida_sos_api_key is malformed — paste an sb_ sunbizdata key or a Sunbiz Daily X-API-Key, not a curl command.',
        reason: 'malformed',
      };
    }
    if (info.status === 'salvaged') {
      value = info.usable;
      salvaged = true;
    }
  }
  if (value.length < 8) return { ok: false, error: 'API key looks too short' };
  slots[opts.key] = {
    value,
    source: 'claude',
    updated_by: by,
    updated_at: new Date().toISOString(),
  };
  let persistError: string | null = null;
  if (opts.persist !== false) persistError = await persistSetting(opts.key, value, by);
  return {
    ok: true,
    ...settingStatus(opts.key),
    salvaged,
    persisted: opts.persist !== false && !persistError,
    persist_error: persistError,
    assistant_instructions:
      'Key is set. Never repeat the full key. Show only the masked fingerprint.',
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
  slots[opts.key] = {
    ...emptySlot(envFallback[opts.key]),
    updated_by: by,
    updated_at: new Date().toISOString(),
  };
  if (hasSupabase()) await persistSetting(opts.key, '', by);
  return {
    ok: true,
    ...settingStatus(opts.key),
    note: envFallback[opts.key] ? 'Reverted to env fallback' : 'No key configured',
  };
}
