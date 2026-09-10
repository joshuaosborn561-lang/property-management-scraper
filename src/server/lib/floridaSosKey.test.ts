import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { clearAppSetting, setAppSetting, settingStatus } from './appSettings.js';
import { formatApiError, inspectFloridaSosKey } from './floridaSosKey.js';

describe('inspectFloridaSosKey', () => {
  it('treats empty as missing', () => {
    const info = inspectFloridaSosKey('  ');
    assert.equal(info.status, 'missing');
    assert.equal(info.usable, '');
    assert.equal(info.reason, null);
  });

  it('treats an sb_ token as a Sunbiz Daily X-API-Key', () => {
    const info = inspectFloridaSosKey('sb_live_testkey_123');
    assert.equal(info.status, 'ok');
    assert.equal(info.provider, 'sunbizdaily');
    assert.equal(info.usable, 'sb_live_testkey_123');
  });

  it('accepts a Sunbiz Daily token', () => {
    const info = inspectFloridaSosKey('AbCdEfGhIjKlMnOp');
    assert.equal(info.status, 'ok');
    assert.equal(info.provider, 'sunbizdaily');
  });

  it('rejects a pasted curl with no extractable key', () => {
    const info = inspectFloridaSosKey('curl https://www.sunbizdaily.com/api/v2/filings/');
    assert.equal(info.status, 'malformed');
    assert.equal(info.usable, '');
    assert.equal(info.reason, 'malformed');
  });

  it('rejects a value that starts with curl and ends like a URL path', () => {
    const info = inspectFloridaSosKey('curl -s https://example.com/api/v2/filings/');
    assert.equal(info.status, 'malformed');
    assert.equal(info.usable, '');
  });

  it('salvages X-API-Key from a pasted curl', () => {
    const info = inspectFloridaSosKey(
      `curl 'https://api.sunbizdata.com/api/v1/corporations/search/name?name=TAMPA' -H 'x-api-key: sb_salvaged_test_key'`,
    );
    assert.equal(info.status, 'salvaged');
    assert.equal(info.salvaged, true);
    assert.equal(info.usable, 'sb_salvaged_test_key');
    assert.equal(info.provider, 'sunbizdaily');
  });

  it('salvages a Bearer token from a pasted curl', () => {
    const info = inspectFloridaSosKey(
      `curl https://www.sunbizdaily.com/api/v2/filings/ -H "Authorization: Bearer daily_token_abcdef"`,
    );
    assert.equal(info.status, 'salvaged');
    assert.equal(info.usable, 'daily_token_abcdef');
    assert.equal(info.provider, 'sunbizdaily');
  });
});

describe('formatApiError', () => {
  it('does not stringify objects as [object Object]', () => {
    assert.equal(formatApiError({ error: { code: 401, msg: 'nope' } }, 'fallback'), '{"code":401,"msg":"nope"}');
    assert.equal(formatApiError({ detail: 'Unauthorized' }, 'fallback'), 'Unauthorized');
    assert.equal(formatApiError({ error: 'Unauthorized' }, 'fallback'), 'Unauthorized');
    assert.equal(formatApiError(null, 'Unauthorized'), 'Unauthorized');
  });
});

describe('setAppSetting florida_sos_api_key', { concurrency: false }, () => {
  afterEach(async () => {
    await clearAppSetting({ key: 'florida_sos_api_key', set_by: 'test' });
  });

  it('rejects a pasted curl with no extractable key', async () => {
    const result = await setAppSetting({
      key: 'florida_sos_api_key',
      api_key: 'curl https://www.sunbizdaily.com/api/v2/filings/',
      persist: false,
      set_by: 'test',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'malformed');
  });

  it('salvages and stores the token from a pasted curl', async () => {
    const result = await setAppSetting({
      key: 'florida_sos_api_key',
      api_key: `curl https://api.sunbizdata.com/x -H 'x-api-key: sb_salvaged_store_key'`,
      persist: false,
      set_by: 'test',
    });
    assert.equal(result.ok, true);
    assert.equal(result.salvaged, true);
    assert.equal(result.configured, true);
    const status = settingStatus('florida_sos_api_key');
    assert.equal(status.configured, true);
    assert.equal(status.reason, null);
    assert.equal(status.source, 'claude');
  });

  it('does not report success when persist is required and Supabase is missing', async () => {
    const before = settingStatus('florida_sos_api_key');
    const result = await setAppSetting({
      key: 'florida_sos_api_key',
      api_key: 'sb_live_testkey_123',
      persist: true,
      set_by: 'test',
    });
    assert.equal(result.ok, false);
    assert.equal(result.persisted, false);
    assert.match(String(result.error), /persist|Supabase/i);
    const after = settingStatus('florida_sos_api_key');
    assert.equal(after.source, before.source);
    assert.notEqual(after.source, 'claude');
  });
});
