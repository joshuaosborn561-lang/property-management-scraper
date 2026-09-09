import { config } from '../config.js';
import { getShovelsApiKey, hasShovelsApi as hasRuntimeKey } from './shovelsKey.js';
import type { GeoKind, ShovelsApiContractor, ShovelsGeo, ShovelsHeaders } from './shovels.js';

export const PERMITSTACK_BASE =
  config.permitstackBaseUrl || 'https://api.permit-stack.com';

/** Developer plan hard cap (from 429 body). Client throttle stays under this. */
export const DEVELOPER_PLAN_PER_MINUTE = 60;
export const CLIENT_THROTTLE_PER_MINUTE = 50;

export function hasPermitstackApi(): boolean {
  return hasRuntimeKey();
}

export class PermitstackHttpError extends Error {
  status: number;
  path: string;
  retryAfterSec: number | null;

  constructor(status: number, path: string, detail: string, retryAfterSec: number | null = null) {
    super(`PermitStack ${status} ${path}: ${detail}`);
    this.name = 'PermitstackHttpError';
    this.status = status;
    this.path = path;
    this.retryAfterSec = retryAfterSec;
  }
}

export class PermitstackRateLimiter {
  private stamps: number[] = [];

  constructor(
    readonly maxPerMinute = CLIENT_THROTTLE_PER_MINUTE,
    private readonly now: () => number = Date.now,
    private readonly sleepFn: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async acquire(): Promise<void> {
    const windowMs = 60_000;
    for (;;) {
      const t = this.now();
      this.stamps = this.stamps.filter((s) => t - s < windowMs);
      if (this.stamps.length < this.maxPerMinute) {
        this.stamps.push(t);
        return;
      }
      const oldest = this.stamps[0] ?? t;
      const wait = Math.max(25, windowMs - (t - oldest) + 25);
      await this.sleepFn(wait);
    }
  }
}

let sharedLimiter = new PermitstackRateLimiter();

export function getSharedPermitstackLimiter(): PermitstackRateLimiter {
  return sharedLimiter;
}

export function setSharedPermitstackLimiter(limiter: PermitstackRateLimiter): void {
  sharedLimiter = limiter;
}

/** Tests: never sleep. Production code must not call this. */
export function disablePermitstackLimiterForTests(): void {
  sharedLimiter = new PermitstackRateLimiter(10_000, Date.now, async () => undefined);
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

function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum)) return Math.max(0, asNum);
  const when = Date.parse(raw);
  if (!Number.isFinite(when)) return null;
  return Math.max(0, (when - Date.now()) / 1000);
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
  await sharedLimiter.acquire();
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
    throw new PermitstackHttpError(res.status, path, detail, parseRetryAfter(res));
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
    const rawName = (geo.name || parsed.city || '')
      .replace(/,\s*[A-Za-z]{2}$/i, '')
      .trim();
    const core = (parsed.city || rawName)
      .replace(/\s+(county|parish|borough)$/i, '')
      .trim();
    const jurisdiction = /\b(county|parish|borough)\b/i.test(rawName)
      ? rawName
      : `${core} County`;
    // Do not send city=core — "Hillsborough County" is not the city of Hillsborough.
    return { state, jurisdiction };
  }
  const city = (parsed.city || geo.name || '')
    .replace(/,\s*[A-Za-z]{2}$/i, '')
    .trim();
  return { city, state };
}

export function countyJurisdictionError(geo: Pick<ShovelsGeo, 'name' | 'state'>): string {
  const label = geo.name || 'this county';
  return (
    `PermitStack jurisdiction search for "${label}" returned 0 permits. ` +
    `County geos are not queried as city="${label.replace(/\s+County.*$/i, '')}". ` +
    `Use a city (e.g. Tampa, FL) or ZIPs instead.`
  );
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

export function uniquePermitContractors(permits: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const p of permits) {
    const name = strOrNull(p.contractor_name);
    const contractorId = strOrNull(p.contractor_id);
    if (!contractorId && !name) continue;
    const key = (contractorId || name || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: contractorId || `name:${slugGeoPart(name || 'unknown')}`,
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

export function isSyntheticContractorId(id: string | null | undefined): boolean {
  return Boolean(id && id.startsWith('name:'));
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
  via: 'contractors' | 'permits_zip' | 'permits_jurisdiction';
  county_query_empty: boolean;
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
      via: 'permits_zip',
      county_query_empty: false,
    };
  }
  if (opts.geo.kind === 'county' || loc.jurisdiction) {
    const res = await searchPermitstackPermits({
      jurisdiction: loc.jurisdiction,
      state: loc.state,
      property_type: opts.property_type,
      date_after: opts.permit_from,
      date_before: opts.permit_to,
      page,
      per_page: opts.size,
    });
    const items = uniquePermitContractors(res.items);
    return {
      items,
      next_cursor: res.next_page != null ? String(res.next_page) : null,
      total_count_raw: { value: res.total, relation: res.total_capped ? 'gte' : 'eq' },
      headers: res.headers,
      via: 'permits_jurisdiction',
      county_query_empty: page === 1 && items.length === 0 && res.total === 0,
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
    via: 'contractors',
    county_query_empty: false,
  };
}

export type PermitstackGetFn = typeof permitstackGet;

export interface HydrationCounters {
  attempted: number;
  hydrated_ok: number;
  hydrated_rate_limited: number;
  hydrated_failed: number;
  hydrated_skipped_synthetic_id: number;
  requests: number;
  http_attempts: number;
  rate_limited: boolean;
}

export const EMPTY_HYDRATION: HydrationCounters = {
  attempted: 0,
  hydrated_ok: 0,
  hydrated_rate_limited: 0,
  hydrated_failed: 0,
  hydrated_skipped_synthetic_id: 0,
  requests: 0,
  http_attempts: 0,
  rate_limited: false,
};

function sleepMs(ms: number, sleepFn?: (ms: number) => Promise<void>): Promise<void> {
  if (sleepFn) return sleepFn(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): err is PermitstackHttpError {
  return err instanceof PermitstackHttpError && err.status === 429;
}

function isContactPlanError(err: unknown): boolean {
  return err instanceof PermitstackHttpError && (err.status === 403 || err.status === 404);
}

async function getProfileWithRetry(
  id: string,
  getFn: PermitstackGetFn,
  sleepFn: (ms: number) => Promise<void>,
  attempts = 4,
): Promise<{ body: unknown; attempts: number }> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const { body } = await getFn(`/v1/contractors/${id}`);
      return { body, attempts: i + 1 };
    } catch (err) {
      lastErr = err;
      if (isContactPlanError(err)) throw err;
      if (!isRateLimitError(err) || i === attempts - 1) throw err;
      const waitSec = err.retryAfterSec != null && err.retryAfterSec > 0 ? err.retryAfterSec : 2 ** i;
      await sleepFn(Math.round(waitSec * 1000));
    }
  }
  throw lastErr;
}

/**
 * Resolve permit-derived `name:` ids to real contractor ids via /v1/contractors/search.
 * One search request per synthetic row (rate-limited with the shared budget).
 */
export async function resolveSyntheticContractorIds(
  items: ShovelsApiContractor[],
  opts: { get?: PermitstackGetFn; max?: number } = {},
): Promise<{ items: ShovelsApiContractor[]; resolved: number; unresolved: number; requests: number }> {
  const getFn = opts.get ?? permitstackGet;
  const max = Math.max(0, opts.max ?? items.length);
  const out = items.map((c) => ({ ...c }));
  let resolved = 0;
  let unresolved = 0;
  let requests = 0;
  let tried = 0;
  for (let i = 0; i < out.length; i += 1) {
    const row = out[i]!;
    if (!isSyntheticContractorId(row.id)) continue;
    if (tried >= max) {
      unresolved += 1;
      continue;
    }
    tried += 1;
    const name = row.business_name || row.name;
    if (!name) {
      unresolved += 1;
      continue;
    }
    try {
      const { body } = await getFn('/v1/contractors/search', {
        name,
        city: row.address_city || undefined,
        state: row.address_state || undefined,
        page: 1,
        per_page: 5,
      });
      requests += 1;
      const rec = body as { results?: unknown };
      const hits = Array.isArray(rec.results)
        ? rec.results.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
        : [];
      const want = name.toLowerCase().trim();
      const hit =
        hits.find((h) => String(h.name || '').toLowerCase().trim() === want) ||
        hits.find((h) => String(h.id || '')) ||
        null;
      const id = hit ? strOrNull(hit.id) : null;
      if (id && !isSyntheticContractorId(id)) {
        out[i] = { ...row, id };
        resolved += 1;
      } else {
        unresolved += 1;
      }
    } catch {
      unresolved += 1;
    }
  }
  return { items: out, resolved, unresolved, requests };
}

export async function hydratePermitstackProfiles(
  items: ShovelsApiContractor[],
  opts: {
    max?: number;
    get?: PermitstackGetFn;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ items: ShovelsApiContractor[]; requests: number } & HydrationCounters> {
  const max = Math.max(0, opts.max ?? items.length);
  const getFn = opts.get ?? permitstackGet;
  const sleepFn = opts.sleep ?? ((ms: number) => sleepMs(ms));
  const out = items.map((c) => ({ ...c }));
  const counters: HydrationCounters = { ...EMPTY_HYDRATION };
  let consecutiveRateLimits = 0;

  for (let i = 0; i < out.length && counters.attempted < max; i += 1) {
    const row = out[i]!;
    if (!row.id || isSyntheticContractorId(row.id)) {
      counters.hydrated_skipped_synthetic_id += 1;
      continue;
    }
    counters.attempted += 1;
    if (consecutiveRateLimits >= 2) {
      counters.hydrated_rate_limited += 1;
      counters.rate_limited = true;
      continue;
    }
    try {
      const { body, attempts } = await getProfileWithRetry(row.id, getFn, sleepFn);
      counters.http_attempts += attempts;
      counters.requests += 1;
      counters.hydrated_ok += 1;
      consecutiveRateLimits = 0;
      if (body && typeof body === 'object') {
        const mapped = mapPermitstackContractor(body as Record<string, unknown>, row.places[0] || '');
        out[i] = {
          ...row,
          ...mapped,
          id: row.id,
          places: row.places,
        };
      }
    } catch (err) {
      if (isRateLimitError(err)) {
        counters.http_attempts += 4;
        counters.hydrated_rate_limited += 1;
        counters.rate_limited = true;
        consecutiveRateLimits += 1;
      } else if (isContactPlanError(err)) {
        counters.http_attempts += 1;
        counters.hydrated_failed += 1;
      } else {
        counters.http_attempts += 1;
        counters.hydrated_failed += 1;
      }
    }
  }

  // Anything past max that we never walked is not attempted — callers page instead.
  return { items: out, ...counters };
}
