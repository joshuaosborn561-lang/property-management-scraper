import {
  countyJurisdictionError,
  getPermitstackUsage,
  hasPermitstackApi,
  mapPermitstackContractor,
  parseGeoId,
  permitstackSearchContractorsPage,
  synthesizeGeoId,
} from './permitstack.js';

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM',
  'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
]);

export type GeoKind = 'city' | 'county' | 'state' | 'zip';

export interface ShovelsHeaders {
  credits_request: number | null;
  credits_limit: number | null;
  credits_remaining: number | null;
  /** Raw header dump for debugging when credit fields are missing. */
  raw?: Record<string, string>;
}

export interface ShovelsGeo {
  geo_id: string;
  name: string;
  state?: string;
  kind: GeoKind;
}

export interface ContractorCountProbe {
  geo: ShovelsGeo;
  total_count: number;
  count_relation: string | null;
  /** Raw total_count field from Shovels (object or number) for debugging fake "1"s. */
  total_count_raw: unknown;
  items_on_probe: number;
  /** Response `size` field (items returned this page). */
  page_size_returned: number;
  has_more: boolean;
  next_cursor: string | null;
  /** True when total_count looks like a size=1 artifact (1 with more pages). */
  count_unreliable: boolean;
  headers: ShovelsHeaders;
  /** True when Shovels returned no usable count and empty first page. */
  no_coverage: boolean;
  /** County jurisdiction search returned 0 — not a silent city miss. */
  county_query_empty?: boolean;
  coverage_error?: string | null;
}

export interface ShovelsApiContractor {
  id: string;
  name: string | null;
  business_name: string | null;
  dba: string | null;
  phone: string | null;
  primary_phone: string | null;
  email: string | null;
  primary_email: string | null;
  website: string | null;
  linkedin_url: string | null;
  employee_count: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  places: string[];
  permit_count: number | null;
  total_job_value: number | null;
  primary_industry: string | null;
  business_type: string | null;
}

export class GeoResolutionError extends Error {
  requested: Record<string, unknown>;
  resolved: Record<string, unknown> | null;

  constructor(message: string, requested: Record<string, unknown>, resolved: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'GeoResolutionError';
    this.requested = requested;
    this.resolved = resolved;
  }
}

export function hasShovelsApi(): boolean {
  return hasPermitstackApi();
}

export async function getShovelsUsage(): Promise<Record<string, unknown> | null> {
  return getPermitstackUsage();
}

/** Shovels returns total_count as `{ value, relation }` — not a bare number. */
export function parseTotalCount(raw: unknown): { value: number; relation: string | null } {
  if (raw == null) return { value: 0, relation: null };
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { value: raw, relation: 'eq' };
  }
  if (typeof raw === 'object') {
    const obj = raw as { value?: unknown; relation?: unknown; count?: unknown };
    if (obj.value != null) {
      const v = Number(obj.value);
      return {
        value: Number.isFinite(v) ? v : 0,
        relation: obj.relation != null ? String(obj.relation) : 'eq',
      };
    }
    if (obj.count != null) {
      const v = Number(obj.count);
      return { value: Number.isFinite(v) ? v : 0, relation: 'eq' };
    }
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    return { value: Number(raw), relation: 'eq' };
  }
  return { value: 0, relation: null };
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

const ADMIN_UNIT = /\b(county|parish|borough)\b/gi;

/** Strip County/Parish/Borough plus a trailing state suffix so "Denton, TX" == "Denton County". */
export function normalizeAdminGeoName(s: string): string {
  return norm(s)
    .replace(/,\s*[a-z]{2}$/i, '')
    .replace(ADMIN_UNIT, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when resolved name is a legitimate match for the requested needle+kind. */
export function geoNameMatches(
  resolvedName: string,
  kind: GeoKind,
  needle: string,
  state?: string,
): boolean {
  const name = norm(resolvedName);
  const want = norm(needle);
  if (!want) return false;

  if (kind === 'zip') {
    const digits = want.replace(/\D/g, '').slice(0, 5);
    return resolvedName.replace(/\D/g, '').startsWith(digits) || name.includes(digits);
  }
  if (kind === 'state') {
    return name === want || name.startsWith(`${want},`) || name === want.toLowerCase();
  }
  if (kind === 'county') {
    // Shovels county search returns "Denton, TX" (no "County"). Compare cores.
    // Reject city-in-other-county hits: "Hunt, Kerr, TX" / "Texhoma, Sherman, TX".
    const commaParts = name
      .replace(/,\s*[a-z]{2}$/i, '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (commaParts.length >= 2) return false;
    const wantCore = normalizeAdminGeoName(needle);
    const nameCore = normalizeAdminGeoName(resolvedName);
    return Boolean(wantCore) && nameCore === wantCore;
  }
  // city: first segment must equal the needle (rejects "Anna, Collin, TX" for needle "Collin")
  const first = name.split(',')[0]?.trim() || '';
  if (first === want) return true;
  if (first.startsWith(`${want} `)) return true; // "San Antonio"
  return false;
}

/**
 * Pick a geo from search hits. Never returns a mismatched city for a county
 * request (e.g. Hunt → Hunt, Kerr, TX when asking for Hunt County).
 */
export function pickGeo(
  items: Array<{ geo_id?: string; name?: string; state?: string }>,
  kind: 'city' | 'county' | 'zip',
  needle: string,
  state?: string,
): ShovelsGeo | null {
  if (!items.length) return null;
  const want = norm(needle);
  const wantState = state?.trim().toUpperCase() || null;

  let pool = items;
  if (wantState) {
    const filtered = items.filter(
      (i) =>
        (i.state || '').toUpperCase() === wantState ||
        new RegExp(`,\\s*${wantState}\\b`, 'i').test(i.name || ''),
    );
    if (filtered.length) pool = filtered;
  }

  const nameOf = (i: { name?: string }) => norm(i.name || '');

  let hit: (typeof items)[number] | undefined;
  if (kind === 'county') {
    const matches = pool.filter((i) => geoNameMatches(i.name || '', 'county', needle, state));
    hit =
      matches.find((i) => /\b(county|parish|borough)\b/.test(nameOf(i))) ||
      matches.find((i) => nameOf(i) === `${want}, ${(wantState || '').toLowerCase()}`) ||
      matches[0];
  } else if (kind === 'zip') {
    const digits = needle.replace(/\D/g, '').slice(0, 5);
    hit =
      pool.find((i) => i.geo_id === digits || i.geo_id === needle) ||
      pool.find((i) => (i.name || '').replace(/\D/g, '').startsWith(digits));
  } else {
    hit =
      pool.find((i) => nameOf(i) === want) ||
      (wantState
        ? pool.find((i) => nameOf(i) === `${want}, ${wantState.toLowerCase()}`)
        : undefined) ||
      pool.find((i) => nameOf(i).startsWith(`${want},`)) ||
      pool.find((i) => geoNameMatches(i.name || '', 'city', needle, state));
  }

  if (!hit?.geo_id) return null;
  if (!geoNameMatches(hit.name || '', kind, needle, state ?? hit.state)) {
    return null;
  }
  return {
    geo_id: hit.geo_id,
    name: hit.name || needle,
    state: hit.state || wantState || undefined,
    kind,
  };
}

function countyRefusalHint(kind: GeoKind, q: string, state?: string): string {
  if (kind === 'county') {
    return (
      ' Refusing to probe — requested kind is already county. ' +
      'PermitStack does not use Shovels geo_ids; county tokens resolve locally (Denton County, TX → county:denton:tx).'
    );
  }
  return ` Refusing to probe. Pass an explicit level (e.g. "${q} County, ${state || 'TX'}" or geo_level=county).`;
}

function displayGeoName(kind: GeoKind, q: string, state?: string): string {
  const st = state?.trim().toUpperCase();
  if (kind === 'state') return q.toUpperCase();
  if (kind === 'zip') return q;
  if (kind === 'county') {
    const core = q.replace(/\s+(county|parish|borough)$/i, '').trim();
    return st ? `${core} County, ${st}` : `${core} County`;
  }
  return st ? `${q}, ${st}` : q;
}

export async function resolveShovelsGeo(opts: {
  kind: GeoKind;
  q: string;
  /** Optional 2-letter state to disambiguate city/county names nationwide. */
  state?: string;
  /** Recorded search hits — tests must pass this instead of calling the live API. */
  searchItems?: Array<{ geo_id?: string; name?: string; state?: string }>;
}): Promise<ShovelsGeo> {
  const q = opts.q.trim();
  if (!q) throw new GeoResolutionError('Empty PermitStack geo query', { ...opts });

  const asState = q.toUpperCase();
  if (opts.kind === 'state' || (opts.kind !== 'zip' && q.length === 2 && US_STATES.has(asState))) {
    if (!US_STATES.has(asState)) {
      throw new GeoResolutionError(`Unknown US state code "${q}"`, { ...opts });
    }
    return { geo_id: synthesizeGeoId('state', asState), name: asState, state: asState, kind: 'state' };
  }

  if (opts.kind === 'zip' || /^\d{5}(-\d{4})?$/.test(q)) {
    const zip = q.replace(/\D/g, '').slice(0, 5);
    if (!/^\d{5}$/.test(zip)) {
      throw new GeoResolutionError(`Invalid ZIP "${q}"`, { ...opts });
    }
    return { geo_id: synthesizeGeoId('zip', zip), name: zip, state: opts.state, kind: 'zip' };
  }

  // PermitStack has no city/county search index — resolve locally.
  // searchItems is only for fixture tests of the old matcher.
  if (opts.searchItems) {
    const pickKind = opts.kind === 'county' ? 'county' : 'city';
    const geo = pickGeo(opts.searchItems, pickKind, q, opts.state);
    if (!geo) {
      const top = opts.searchItems.slice(0, 3).map((i) => i.name).filter(Boolean);
      throw new GeoResolutionError(
        `No PermitStack ${opts.kind} match for "${q}"${opts.state ? ` (${opts.state})` : ''}` +
          (top.length ? ` — top hits were: ${top.join(' | ')}` : ' — empty search result') +
          `.${countyRefusalHint(opts.kind, q, opts.state)}`,
        { kind: opts.kind, q, state: opts.state },
        top.length ? { top_hits: top } : null,
      );
    }
    if (!geoNameMatches(geo.name, geo.kind, q, opts.state ?? geo.state)) {
      throw new GeoResolutionError(
        `Requested ${opts.kind} "${q}" resolved to "${geo.name}" (${geo.geo_id}) — mismatch, refusing to probe`,
        { kind: opts.kind, q, state: opts.state },
        { resolved_geo_id: geo.geo_id, resolved_name: geo.name, resolved_kind: geo.kind, resolved_state: geo.state },
      );
    }
    return geo;
  }

  const kind = opts.kind === 'county' ? 'county' : 'city';
  const core = q.replace(/\s+(county|parish|borough)$/i, '').trim();
  const state = opts.state?.trim().toUpperCase();
  if (kind === 'city' && !core) {
    throw new GeoResolutionError(`Empty city name`, { ...opts });
  }
  return {
    geo_id: synthesizeGeoId(kind, core, state),
    name: displayGeoName(kind, core, state),
    state,
    kind,
  };
}

export async function probeContractorCount(opts: {
  geo: ShovelsGeo;
  permit_from: string;
  permit_to: string;
  property_type?: string;
  /**
   * Probe page size. Default 1 — this account bills per *record* returned
   * (x-credits-request ≈ size), so size=100 would burn 100 credits for one geo.
   * include_count still returns the full {value,relation} total at size=1.
   */
  size?: number;
}): Promise<ContractorCountProbe> {
  const page = await permitstackSearchContractorsPage({
    geo: opts.geo,
    permit_from: opts.permit_from,
    permit_to: opts.permit_to,
    property_type: opts.property_type,
    size: 1,
  });
  const parsed = parseTotalCount(page.total_count_raw);
  const itemsOnPage = page.items.length;
  const hasMore = Boolean(page.next_cursor);
  const countyEmpty =
    opts.geo.kind === 'county' &&
    (page.county_query_empty === true || (parsed.value === 0 && !hasMore && itemsOnPage === 0));
  return {
    geo: opts.geo,
    total_count: parsed.value,
    count_relation: parsed.relation ?? (hasMore && parsed.value > 0 ? 'gte' : null),
    total_count_raw: page.total_count_raw,
    items_on_probe: itemsOnPage,
    page_size_returned: itemsOnPage,
    has_more: hasMore,
    next_cursor: page.next_cursor,
    count_unreliable: false,
    headers: page.headers,
    no_coverage: !countyEmpty && parsed.value === 0 && !hasMore && itemsOnPage === 0,
    county_query_empty: countyEmpty,
    coverage_error: countyEmpty ? countyJurisdictionError(opts.geo) : null,
  };
}

export function mapShovelsApiContractor(raw: Record<string, unknown>, placeTag: string): ShovelsApiContractor {
  return mapPermitstackContractor(raw, placeTag);
}

export async function shovelsSearchContractorsPage(opts: {
  geo_id: string;
  permit_from: string;
  permit_to: string;
  property_type?: string;
  size: number;
  cursor?: string | null;
  include_count?: boolean;
}): Promise<{
  items: Record<string, unknown>[];
  next_cursor: string | null;
  total_count_raw: unknown;
  headers: ShovelsHeaders;
}> {
  const parsed = parseGeoId(opts.geo_id);
  const geo: ShovelsGeo = {
    geo_id: opts.geo_id,
    name: parsed.city || parsed.zip || parsed.state || opts.geo_id,
    state: parsed.state,
    kind: parsed.kind || 'city',
  };
  return permitstackSearchContractorsPage({
    geo,
    permit_from: opts.permit_from,
    permit_to: opts.permit_to,
    property_type: opts.property_type,
    size: opts.size,
    cursor: opts.cursor,
  });
}

export async function pullContractorsForGeo(opts: {
  geo: ShovelsGeo;
  place: string;
  permit_from: string;
  permit_to: string;
  property_type?: string;
  page_size?: number;
  max_records?: number;
  max_pages?: number;
  /** Resume from a stored cursor (skips include_count on first page). */
  start_cursor?: string | null;
  /** Abort if credits_remaining drops below this after a page. */
  min_credits_remaining?: number;
  fetchPage?: typeof shovelsSearchContractorsPage;
}): Promise<{
  items: ShovelsApiContractor[];
  pages: number;
  credits_spent: number;
  truncated: boolean;
  next_cursor: string | null;
  headers_last: ShovelsHeaders | null;
  stopped_reason: 'complete' | 'max_records' | 'credit_floor' | 'empty' | null;
}> {
  const pageSize = Math.min(100, Math.max(1, opts.page_size ?? 100));
  const maxRecords = Math.max(1, opts.max_records ?? 2000);
  const maxPages = Math.max(1, opts.max_pages ?? 500);
  const minCredits = opts.min_credits_remaining ?? 0;
  const fetchPage = opts.fetchPage ?? shovelsSearchContractorsPage;
  const items: ShovelsApiContractor[] = [];
  let cursor: string | null = opts.start_cursor ?? null;
  let pages = 0;
  let credits = 0;
  let headersLast: ShovelsHeaders | null = null;
  let truncated = false;
  let stopped: 'complete' | 'max_records' | 'credit_floor' | 'empty' | null = null;
  let first = true;

  while (pages < maxPages) {
    // Hard stop BEFORE spending another request.
    if (items.length >= maxRecords) {
      truncated = true;
      stopped = 'max_records';
      break;
    }
    const remaining = maxRecords - items.length;
    const size = Math.min(pageSize, remaining);
    if (size <= 0) {
      truncated = true;
      stopped = 'max_records';
      break;
    }

    const page = await fetchPage({
      geo_id: opts.geo.geo_id,
      permit_from: opts.permit_from,
      permit_to: opts.permit_to,
      property_type: opts.property_type,
      size,
      cursor,
      include_count: first && !opts.start_cursor,
    });
    first = false;
    headersLast = page.headers;
    credits += page.headers.credits_request ?? 0;
    pages += 1;

    if (
      page.headers.credits_remaining != null &&
      page.headers.credits_remaining < minCredits
    ) {
      // Still keep whatever we got on this page, then stop.
      for (const raw of page.items) {
        const mapped = mapShovelsApiContractor(raw, opts.place);
        if (!mapped.id) continue;
        items.push(mapped);
        if (items.length >= maxRecords) break;
      }
      cursor = page.next_cursor;
      truncated = true;
      stopped = 'credit_floor';
      break;
    }

    for (const raw of page.items) {
      const mapped = mapShovelsApiContractor(raw, opts.place);
      if (!mapped.id) continue;
      items.push(mapped);
      if (items.length >= maxRecords) break;
    }

    cursor = page.next_cursor;
    if (!cursor || !page.items.length) {
      stopped = page.items.length ? 'complete' : items.length ? 'complete' : 'empty';
      break;
    }
    if (items.length >= maxRecords) {
      truncated = true;
      stopped = 'max_records';
      break;
    }
  }

  if (!stopped && cursor) {
    truncated = true;
    stopped = 'max_records';
  }

  return {
    items,
    pages,
    credits_spent: credits,
    truncated,
    next_cursor: cursor,
    headers_last: headersLast,
    stopped_reason: stopped,
  };
}
