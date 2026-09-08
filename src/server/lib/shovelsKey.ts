import {
  clearAppSetting,
  getSetting,
  getSettingStatus,
  loadAppSettings,
  maskKey,
  setAppSetting,
  settingStatus,
} from './appSettings.js';

export { maskKey, loadAppSettings as loadPersistedShovelsKey };

export function getShovelsApiKey(): string {
  return getSetting('shovels_api_key');
}

export function hasShovelsApi(): boolean {
  return Boolean(getShovelsApiKey());
}

export function shovelsKeyStatus() {
  return settingStatus('shovels_api_key');
}

export async function getShovelsKeyStatus() {
  await loadAppSettings();
  return getSettingStatus('shovels_api_key');
}

export async function setShovelsApiKey(opts: {
  api_key: string;
  set_by?: string;
  persist?: boolean;
}): Promise<Record<string, unknown>> {
  const result = await setAppSetting({
    key: 'shovels_api_key',
    api_key: opts.api_key,
    set_by: opts.set_by,
    persist: opts.persist,
  });
  if (result.ok) {
    result.assistant_instructions =
      'PermitStack key is set. Never repeat the full key in chat. Show only the masked fingerprint, then call permitstack_estimate_credits (alias shovels_estimate_credits).';
  }
  return result;
}

export async function clearShovelsApiKey(opts: { set_by?: string } = {}): Promise<Record<string, unknown>> {
  return clearAppSetting({ key: 'shovels_api_key', set_by: opts.set_by });
}

/** PermitStack key — stored in the existing shovels_api_key slot so persist RPCs keep working. */
export const getPermitstackApiKey = getShovelsApiKey;
export const hasPermitstackApi = hasShovelsApi;
export const permitstackKeyStatus = shovelsKeyStatus;
export const getPermitstackKeyStatus = getShovelsKeyStatus;
export const setPermitstackApiKey = setShovelsApiKey;
export const clearPermitstackApiKey = clearShovelsApiKey;
