import { config } from '../config.js';
import { getShovelsApiKey, hasShovelsApi as hasRuntimeKey } from './shovelsKey.js';
import type { GeoKind, ShovelsApiContractor, ShovelsGeo, ShovelsHeaders } from './shovels.js';

export const PERMITSTACK_BASE =
  config.permitstackBaseUrl || 'https://api.permit-stack.com';

export function hasPermitstackApi(): boolean {
  return hasRuntimeKey();
}

function headerNum(res: Response, ...names: string[]): number | null {
  for (const name of names) {
    const raw = res.headers.get(name);
    if (raw == null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function permitstackHeaders(res: Response): ShovelsHeaders {
  const raw: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (/rate|limit|remain|credit|quota|usage|plan|request|retry/i.test(k) || /^x-/i.test(k)) {
      raw[k] = v;
    }
  });
  const remaining = headerNum(
    res,
    'x-ratelimit-remaining',
    'x-rate-limit-remaining',
    'x-requests-remaining',
    'x-credits-remaining',
  );
  const limit = headerNum(
    res,
    'x-ratelimit-limit',
    'x-rate-limit-limit',
    'x-requests-limit',
    'x-credits-limit',
  );
  return {
    // PermitStack bills 1 HTTP request per call (page or profile).
    credits_request: 1,
    credits_limit: limit,
    credits_remaining: remaining,
    raw: Object.keys(raw).length ? raw : undefined,
  };
}

export async function permitstackGet(
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<{ body: unknown; headers: ShovelsHeaders; status: number }> {
  const apiKey = getShovelsApiKey();
  if (!apiKey) {
    throw new Error(
      'PERMITSTACK_API_KEY is not configured — Cayden can set it with permitstack_set_api_key (alias shovels_set_api_key)',
    );
  }
  const url = new URL(path.startsWith('http') ? path : `${PERMITSTACK_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-API-Key': apiKey,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const detail =
      typeof body === 'object' && body && 'detail' in body
        ? JSON.stringify((body as { detail: unknown }).detail).slice(0, 240)
        : text.slice(0, 240);
    throw new Error(`PermitStack ${res.status} ${path}: ${detail}`);
  }
  return { body, headers: permitstackHeaders(res), status: res.status };
}

export async function getPermitstackUsage(): Promise<Record<string, unknown> | null> {
  if (!hasPermitstackApi()) return null;
  try {
    const health = await permitstackGet('/health');
    const stats = await permitstackGet('/stats');
    return {
      provider: 'permitstack',
      billing: '1 request = 1 HTTP call (search page or contractor profile). Free tier is 100 requests/day.',
      health: health.body,
      stats: stats.body,
      headers: health.headers,
    };
  } catch {
    return {
      provider: 'permitstack',
      billing: '1 request = 1 HTTP call. No /usage meter on this API.',
    };
  }
}

export function slugGeoPart(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function synthesizeGeoId(kind: GeoKind, q: string, state?: string): string {
  if (kind === 'state') return `state:${q.trim().toUpperCase()}`;
  if (kind === 'zip') return `zip:${q.replace(/\D/g, '').slice(0, 5)}`;
  const st = (state || '').trim().toLowerCase();
  return `${kind}:${slugGeoPart(q)}${st ? `:${st}` : ''}`;
}

export function parseGeoId(geoId: string): {
  kind: GeoKind | null;
  city?: string;
  state?: string;
  zip?: string;
} {
  const raw = geoId.trim();
  const zipHit = raw.match(/^zip:(\d{5})$/i);
  if (zipHit) return { kind: 'zip', zip: zipHit[1] };
  const stateHit = raw.match(/^state:([A-Za-z]{2})$/i);
  if (stateHit) return { kind: 'state', state: stateHit[1]!.toUpperCase() };
  const typed = raw.match(/^(city|county):([a-z0-9-]+)(?::([a-z]{2}))?$/i);
  if (typed) {
    const kind = typed[1]!.toLowerCase() as 'city' | 'county';
    const city = typed[2]!.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return { kind, city, state: typed[3] ? typed[3].toUpperCase() : undefined };
  }
  return { kind: null };
}

export function cityQueryForGeo(geo: ShovelsGeo): {
  city?: string;
  state?: string;
  zip?: string;
  jurisdiction?: string;
} {
  const parsed = parseGeoId(geo.geo_id);
  if (parsed.kind === 'zip') return { zip: parsed.zip, state: geo.state };
  if (parsed.kind === 'state') return { state: parsed.state || geo.state };
  const state = geo.state || parsed.state;
  if (geo.kind === 'county' || parsed.kind === 'county') {
    const core = (parsed.city || geo.name || '')
      .replace(/,\s*[A-Za-z]{2}$/i, '')
      .replace(/\s+(county|parish|borough)$/i, '')
      .trim();
    return {
      city: core,
      state,
      jurisdiction: `${core} County`,
    };
  }
  const city = (parsed.city || geo.name || '')
    .replace(/,\s*[A-Za-z]{2}$/i, '')
    .trim();
  return { city, state };
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mapPermitstackContractor(raw: Record<string, unknown>, placeTag: string): ShovelsApiContractor {
  const addr =
    raw.address && typeof raw.address === 'object' ? (raw.address as Record<string, unknown>) : {};
  const streetFromObj = [strOrNull(addr.street_no), strOrNull(addr.street)].filter(Boolean).join(' ');
  const street =
    (typeof raw.address === 'string' ? strOrNull(raw.address) : null) ||
    (streetFromObj || null) ||
    strOrNull(addr.street);
  const specialties = Array.isArray(raw.specialties)
    ? (raw.specialties as unknown[]).map((s) => String(s)).filter(Boolean)
    : [];
  return {
    id: String(raw.id ?? ''),
    name: strOrNull(raw.name),
    business_name: strOrNull(raw.business_name) || strOrNull(raw.name),
    dba: strOrNull(raw.dba),
    phone: strOrNull(raw.phone),
    primary_phone: strOrNull(raw.primary_phone) || strOrNull(raw.phone),
    email: strOrNull(raw.email),
    primary_email: strOrNull(raw.primary_email) || strOrNull(raw.email),
    website: strOrNull(raw.website),
    linkedin_url: strOrNull(raw.linkedin_url),
    employee_count: strOrNull(raw.employee_count),
    address_street: street,
    address_city: strOrNull(raw.city) || strOrNull(addr.city),
    address_state: strOrNull(raw.state) || strOrNull(addr.state),
    address_zip: strOrNull(raw.zip_code) || strOrNull(raw.zip) || strOrNull(addr.zip_code) || strOrNull(addr.zip),
    places: [placeTag],
    permit_count: numOrNull(raw.total_permits) ?? numOrNull(raw.permit_count),
    total_job_value: numOrNull(raw.avg_project_value) ?? numOrNull(raw.total_job_value),
    primary_industry: specialties.length ? specialties.join('|') : strOrNull(raw.primary_industry),
    business_type: raw.is_business === true ? 'business' : strOrNull(raw.business_type),
  };
}

function asRecordArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object');
}

export async function searchPermitstackContractors(opts: {
  city?: string;
  state?: string;
  name?: string;
  specialty?: string;
  min_permits?: number;
  page: number;
  per_page: number;
}): Promise<{
  items: Record<string, unknown>[];
  total: number;
  page: number;
  per_page: number;
  next_page: number | null;
  headers: ShovelsHeaders;
}> {
  const { body, headers } = await permitstackGet('/v1/contractors/search', {
    name: opts.name,
    city: opts.city,
    state: opts.state,
    specialty: opts.specialty,
    min_permits: opts.min_permits,
    sort: 'permits',
    page: opts.page,
    per_page: opts.per_page,
  });
  const rec = body as { results?: unknown; total?: unknown; page?: unknown; per_page?: unknown };
  const items = asRecordArray(rec.results);
  const total = Number(rec.total ?? 0) || 0;
  const page = Number(rec.page ?? opts.page) || opts.page;
  const perPage = Number(rec.per_page ?? opts.per_page) || opts.per_page;
  const next = page * perPage < total ? page + 1 : null;
  return { items, total, page, per_page: perPage, next_page: next, headers };
}

export async function searchPermitstackPermits(opts: {
  city?: string;
  state?: string;
  zip?: string;
  jurisdiction?: string;
  property_type?: string;
  date_after?: string;
  date_before?: string;
  page: number;
  per_page: number;
}): Promise<{
  items: Record<string, unknown>[];
  total: number;
  total_capped: boolean;
  page: number;
  per_page: number;
  next_page: number | null;
  headers: ShovelsHeaders;
}> {
  const { body, headers } = await permitstackGet('/v1/permits/search', {
    city: opts.city,
    state: opts.state,
    zip_code: opts.zip,
    jurisdiction: opts.jurisdiction,
    property_type: opts.property_type || 'commercial',
    date_after: opts.date_after,
    date_before: opts.date_before,
    page: opts.page,
    per_page: opts.per_page,
  });
  const rec = body as {
    results?: unknown;
    total?: unknown;
    total_capped?: unknown;
    page?: unknown;
    per_page?: unknown;
  };
  const items = asRecordArray(rec.results);
  const total = Number(rec.total ?? 0) || 0;
  const page = Number(rec.page ?? opts.page) || opts.page;
  const perPage = Number(rec.per_page ?? opts.per_page) || opts.per_page;
  const next = page * perPage < total ? page + 1 : null;
  return {
    items,
    total,
    total_capped: rec.total_capped === true,
    page,
    per_page: perPage,
    next_page: next,
    headers,
  };
}

function uniquePermitContractors(permits: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const p of permits) {
    const name = strOrNull(p.contractor_name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `name:${slugGeoPart(name)}`,
      name,
      business_name: name,
      city: strOrNull(p.address_city),
      state: strOrNull(p.address_state),
      zip_code: strOrNull(p.address_zip),
      total_permits: 1,
    });
  }
  return out;
}

export async function permitstackSearchContractorsPage(opts: {
  geo: Pick<ShovelsGeo, 'geo_id' | 'name' | 'state' | 'kind'>;
  permit_from: string;
  permit_to: string;
  property_type?: string;
  size: number;
  cursor?: string | null;
}): Promise<{
  items: Record<string, unknown>[];
  next_cursor: string | null;
  total_count_raw: unknown;
  headers: ShovelsHeaders;
}> {
  const page = opts.cursor && /^\d+$/.test(opts.cursor) ? Math.max(1, Number(opts.cursor)) : 1;
  const loc = cityQueryForGeo(opts.geo as ShovelsGeo);
  if (opts.geo.kind === 'zip' || loc.zip) {
    const res = await searchPermitstackPermits({
      zip: loc.zip,
      state: loc.state,
      property_type: opts.property_type,
      date_after: opts.permit_from,
      date_before: opts.permit_to,
      page,
      per_page: opts.size,
    });
    return {
      items: uniquePermitContractors(res.items),
      next_cursor: res.next_page != null ? String(res.next_page) : null,
      total_count_raw: { value: res.total, relation: res.total_capped ? 'gte' : 'eq' },
      headers: res.headers,
    };
  }
  const res = await searchPermitstackContractors({
    city: loc.city,
    state: loc.state,
    page,
    per_page: opts.size,
  });
  return {
    items: res.items,
    next_cursor: res.next_page != null ? String(res.next_page) : null,
    total_count_raw: { value: res.total, relation: 'eq' },
    headers: res.headers,
  };
}

export async function hydratePermitstackProfiles(
  items: ShovelsApiContractor[],
  opts: { max?: number } = {},
): Promise<{ items: ShovelsApiContractor[]; requests: number }> {
  const max = Math.max(0, opts.max ?? items.length);
  const out = items.map((c) => ({ ...c }));
  let requests = 0;
  for (let i = 0; i < out.length && i < max; i += 1) {
    const row = out[i]!;
    if (!row.id || row.id.startsWith('name:')) continue;
    try {
      const { body } = await permitstackGet(`/v1/contractors/${row.id}`);
      requests += 1;
      if (body && typeof body === 'object') {
        const mapped = mapPermitstackContractor(body as Record<string, unknown>, row.places[0] || '');
        out[i] = {
          ...row,
          ...mapped,
          id: row.id,
          places: row.places,
        };
      }
    } catch {
      // Profile contact is Developer-plan; keep the search row.
    }
  }
  return { items: out, requests };
}
