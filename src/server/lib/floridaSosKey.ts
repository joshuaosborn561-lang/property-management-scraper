export type FloridaSosKeyStatus = 'missing' | 'ok' | 'malformed' | 'salvaged';
export type FloridaSosProvider = 'sunbizdata' | 'sunbizdaily';

export type FloridaSosKeyInspection = {
  raw: string;
  usable: string;
  provider: FloridaSosProvider | null;
  status: FloridaSosKeyStatus;
  reason: 'malformed' | null;
  salvaged: boolean;
};

const HEADER_KEY_RE =
  /(?:^|[\s])(?:-H|--header)\s+['"]?(?:x-api-key|api-key|authorization)\s*:\s*(?:bearer\s+)?([^'"\s]+)['"]?/i;
const QUERY_KEY_RE = /[?&](?:api[_-]?key|x-api-key|key)=([^&\s'"]+)/i;
const BEARER_RE = /bearer\s+([A-Za-z0-9._\-]+)/i;

export function formatApiError(body: unknown, fallback: string): string {
  if (body == null) return fallback;
  if (typeof body === 'string') {
    const t = body.trim();
    if (!t || t === '[object Object]') return fallback;
    return t;
  }
  if (typeof body !== 'object') return String(body);
  const rec = body as Record<string, unknown>;
  const detail = rec.detail ?? rec.error ?? rec.message ?? rec.msg ?? rec.title;
  const fromDetail = stringifyUnknown(detail);
  if (fromDetail) return fromDetail;
  const whole = stringifyUnknown(body);
  return whole || fallback;
}

function stringifyUnknown(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '[object Object]' ? '' : t;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const s = JSON.stringify(value);
    if (!s || s === '{}' || s === '[]' || s === 'null') return '';
    return s;
  } catch {
    return '';
  }
}

export function isSunbizdataKey(key: string): boolean {
  return /^sb_/i.test(key.trim());
}

function looksLikeBareKey(value: string): boolean {
  if (value.length < 8) return false;
  if (/\s/.test(value)) return false;
  if (/^curl\b/i.test(value)) return false;
  if (/https?:\/\//i.test(value)) return false;
  return true;
}

function extractFromCurl(raw: string): string {
  const header = raw.match(HEADER_KEY_RE);
  if (header?.[1]) return header[1].trim();
  const query = raw.match(QUERY_KEY_RE);
  if (query?.[1]) return decodeURIComponent(query[1]).trim();
  const bearer = raw.match(BEARER_RE);
  if (bearer?.[1]) return bearer[1].trim();
  return '';
}

export function inspectFloridaSosKey(raw: string | null | undefined): FloridaSosKeyInspection {
  const trimmed = String(raw || '').trim();
  const empty = {
    raw: trimmed,
    usable: '',
    provider: null as FloridaSosProvider | null,
    status: 'missing' as const,
    reason: null as 'malformed' | null,
    salvaged: false,
  };
  if (!trimmed) return empty;

  let usable = trimmed;
  let salvaged = false;
  if (/^curl\b/i.test(trimmed) || /\s/.test(trimmed) || /https?:\/\//i.test(trimmed)) {
    const extracted = extractFromCurl(trimmed);
    if (!extracted || !looksLikeBareKey(extracted)) {
      return {
        raw: trimmed,
        usable: '',
        provider: null,
        status: 'malformed',
        reason: 'malformed',
        salvaged: false,
      };
    }
    usable = extracted;
    salvaged = true;
  } else if (!looksLikeBareKey(trimmed)) {
    return {
      raw: trimmed,
      usable: '',
      provider: null,
      status: 'malformed',
      reason: 'malformed',
      salvaged: false,
    };
  }

  return {
    raw: trimmed,
    usable,
    provider: isSunbizdataKey(usable) ? 'sunbizdata' : 'sunbizdaily',
    status: salvaged ? 'salvaged' : 'ok',
    reason: null,
    salvaged,
  };
}
