import { randomUUID } from 'node:crypto';
import { nationalChainHit } from '../lib/nationalChain.js';
import {
  countyJurisdictionError,
  EMPTY_HYDRATION,
  hydratePermitstackProfiles,
  isSyntheticContractorId,
  permitstackGet,
  resolveSyntheticContractorIds,
  type HydrationCounters,
} from '../lib/permitstack.js';
import {
  GeoResolutionError,
  hasShovelsApi,
  pullContractorsForGeo,
  resolveShovelsGeo,
  shovelsSearchContractorsPage,
  type ShovelsApiContractor,
  type ShovelsGeo,
} from '../lib/shovels.js';
import { supabaseTargetMeta } from '../lib/supabaseTarget.js';
import { hasSupabase, SCHEMA } from '../lib/supabase.js';
import { upsertCallingListMeta } from './callingLists.js';
import { resolveGeoTargets, type GeoLevelHint, type GeoTarget } from './shovelsGeoTargets.js';
import { loadPullState, pullJobKey, savePullState } from './shovelsPull.js';
import { estimateShovelsCredits } from './shovelsCredits.js';
import { contractorsToCsv, type ShovelsContractor } from './shovelsContractors.js';
import { replaceLeads, upsertExport, upsertJob } from './syncToSupabase.js';

const DEFAULT_MAX_RECORDS = 1500;
const HARD_MAX_RECORDS = 8000;

export interface PullShovelsCallingListInput {
  geos?: string;
  place?: string;
  city?: string;
  state?: string;
  geo_level?: GeoLevelHint;
  date_from?: string;
  date_to?: string;
  property_type?: string;
  page_size?: number;
  max_records?: number;
  has_phone?: boolean;
  has_email?: boolean;
  exclude_national_chains?: boolean;
  min_permit_count?: number;
  max_permit_count?: number;
  name?: string;
  owner?: string;
  /** Must be true to spend Shovels credits on a live pull. */
  confirm?: boolean;
  /** Resume at this PermitStack page (overrides stored offset). */
  cursor?: string;
  /** Skip the first N contractors in fetch order (page = floor(offset/page_size)+1). */
  offset?: number;
  /** Clear stored offsets for these geos and start at record 0. */
  reset_cursor?: boolean;
  fetchPage?: typeof shovelsSearchContractorsPage;
  hydrateProfiles?: typeof hydratePermitstackProfiles;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultWindow() {
  const to = new Date();
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  return { date_from: isoDate(from), date_to: isoDate(to) };
}

function hasContact(v: string | null | undefined): boolean {
  return Boolean(v && String(v).trim());
}

function toContractor(c: ShovelsApiContractor): ShovelsContractor {
  return {
    id: c.id,
    name: c.name,
    business_name: c.business_name,
    dba: c.dba,
    phone: c.phone,
    primary_phone: c.primary_phone,
    email: c.email,
    primary_email: c.primary_email,
    website: c.website,
    linkedin_url: c.linkedin_url,
    employee_count: c.employee_count,
    address_street: c.address_street,
    address_city: c.address_city,
    address_state: c.address_state,
    address_zip: c.address_zip,
    places: c.places,
    permit_count: c.permit_count,
    total_job_value: c.total_job_value,
    primary_industry: c.primary_industry,
    business_type: c.business_type,
  };
}

/** Chain + permit-count only — safe before profile hydration. */
export function applyStructuralFilters(
  items: ShovelsApiContractor[],
  opts: PullShovelsCallingListInput,
): ShovelsApiContractor[] {
  return items.filter((c) => {
    if (opts.min_permit_count != null && (c.permit_count ?? 0) < opts.min_permit_count) return false;
    if (opts.max_permit_count != null && (c.permit_count ?? 0) > opts.max_permit_count) return false;
    if (opts.exclude_national_chains === true && nationalChainHit(c).national_chain) return false;
    return true;
  });
}

/** Phone/email filters — only after hydration. */
export function applyContactFilters(
  items: ShovelsApiContractor[],
  opts: PullShovelsCallingListInput,
): ShovelsApiContractor[] {
  return items.filter((c) => {
    if (opts.has_phone === true && !hasContact(c.phone) && !hasContact(c.primary_phone)) return false;
    if (opts.has_email === true && !hasContact(c.email) && !hasContact(c.primary_email)) return false;
    return true;
  });
}

export function applyFilters(
  items: ShovelsApiContractor[],
  opts: PullShovelsCallingListInput,
): ShovelsApiContractor[] {
  return applyContactFilters(applyStructuralFilters(items, opts), opts);
}

export type CallingListRestartReason =
  | 'explicit_cursor'
  | 'explicit_offset'
  | 'reset_cursor'
  | 'unusable_page_cursor'
  | 'exhausted'
  | 'marked_done'
  | null;

export type CallingListCoverage =
  | 'county_query_empty'
  | 'no_coverage'
  | 'exhausted'
  | 'empty_page'
  | 'ok'
  | 'restart_required';

export type CallingListJobSnapshot = {
  cursor: string | null;
  done?: boolean;
  offset?: number;
  fetched?: number;
  page_size?: number;
  total_count?: number | null;
};

export function pageSkipForOffset(
  offset: number,
  pageSize: number,
): { cursor: string | null; skip: number } {
  if (offset <= 0) return { cursor: null, skip: 0 };
  const page = Math.floor(offset / pageSize) + 1;
  return { cursor: String(page), skip: offset % pageSize };
}

/** Absolute records already consumed — never a raw page index. */
export function recordOffsetFromJob(job: CallingListJobSnapshot | undefined): number | null {
  if (!job) return null;
  if (typeof job.offset === 'number' && Number.isFinite(job.offset) && job.offset >= 0) {
    return job.offset;
  }
  if (typeof job.fetched === 'number' && Number.isFinite(job.fetched) && job.fetched >= 0) {
    return job.fetched;
  }
  if (job.cursor && /^\d+$/.test(job.cursor) && typeof job.page_size === 'number' && job.page_size > 0) {
    const page = Number(job.cursor);
    if (!Number.isFinite(page) || page <= 1) return 0;
    return (page - 1) * job.page_size;
  }
  return null;
}

export function startCursorForGeo(
  opts: PullShovelsCallingListInput,
  persisted: CallingListJobSnapshot | undefined,
  pageSize: number,
): {
  cursor: string | null;
  skip: number;
  resumed: boolean;
  offset: number;
  restart_reason: CallingListRestartReason;
} {
  if (opts.cursor && /^\d+$/.test(opts.cursor)) {
    const page = Math.max(1, Number(opts.cursor));
    return {
      cursor: String(page),
      skip: 0,
      resumed: false,
      offset: (page - 1) * pageSize,
      restart_reason: 'explicit_cursor',
    };
  }
  if (opts.offset != null && opts.offset > 0) {
    const { cursor, skip } = pageSkipForOffset(opts.offset, pageSize);
    return {
      cursor,
      skip,
      resumed: false,
      offset: opts.offset,
      restart_reason: 'explicit_offset',
    };
  }
  if (opts.reset_cursor === true) {
    return { cursor: null, skip: 0, resumed: false, offset: 0, restart_reason: 'reset_cursor' };
  }

  const stored = recordOffsetFromJob(persisted);
  const total = persisted?.total_count ?? null;

  if (stored != null && stored > 0) {
    if (total != null && stored >= total) {
      return { cursor: null, skip: 0, resumed: false, offset: stored, restart_reason: 'exhausted' };
    }
    const { cursor, skip } = pageSkipForOffset(stored, pageSize);
    return { cursor, skip, resumed: true, offset: stored, restart_reason: null };
  }

  if (persisted?.cursor && stored == null) {
    return {
      cursor: null,
      skip: 0,
      resumed: false,
      offset: 0,
      restart_reason: 'unusable_page_cursor',
    };
  }

  if (persisted?.done === true) {
    return { cursor: null, skip: 0, resumed: false, offset: 0, restart_reason: 'marked_done' };
  }

  return { cursor: null, skip: 0, resumed: false, offset: 0, restart_reason: null };
}

export function classifyCallingListCoverage(opts: {
  countyEmpty: boolean;
  totalCount: number | null;
  startOffset: number;
  fetchedThisCall: number;
  nextOffset: number;
  truncated: boolean;
  apiNextCursor: string | null;
}): { coverage: CallingListCoverage; done: boolean } {
  const { countyEmpty, totalCount, startOffset, fetchedThisCall, nextOffset, truncated, apiNextCursor } =
    opts;
  if (countyEmpty) {
    return { coverage: 'county_query_empty', done: true };
  }
  if (totalCount === 0 && fetchedThisCall === 0) {
    return { coverage: 'no_coverage', done: true };
  }
  if (totalCount != null && (startOffset >= totalCount || (fetchedThisCall === 0 && nextOffset >= totalCount))) {
    return { coverage: 'exhausted', done: true };
  }
  if (fetchedThisCall === 0) {
    if (totalCount != null && startOffset < totalCount) {
      return { coverage: 'empty_page', done: false };
    }
    if (startOffset === 0) {
      return { coverage: 'no_coverage', done: true };
    }
    return { coverage: 'exhausted', done: true };
  }
  const reachedApiEnd = !truncated && !apiNextCursor;
  const done = totalCount != null ? nextOffset >= totalCount : reachedApiEnd;
  return { coverage: 'ok', done };
}

function slugOwner(owner: string): string {
  return owner.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'shared';
}

/**
 * Live Shovels pull for any US geo (East/West coast metros, cities, counties, state codes).
 * Without confirm=true, returns a credit estimate only.
 */
export async function pullShovelsCallingList(opts: PullShovelsCallingListInput = {}) {
  const targets = resolveGeoTargets(opts);
  const maxRecords = Math.min(
    HARD_MAX_RECORDS,
    Math.max(1, opts.max_records ?? DEFAULT_MAX_RECORDS),
  );
  const window = {
    date_from: opts.date_from || defaultWindow().date_from,
    date_to: opts.date_to || defaultWindow().date_to,
  };
  const propertyType = opts.property_type || 'commercial';
  const owner = slugOwner(opts.owner || 'cayden');
  const geoLabel = targets.map((t) => t.place).join('+');
  const name =
    opts.name?.trim() ||
    `PermitStack live · ${geoLabel.replace(/_/g, ' ')} · ${owner}`;

  if (!hasShovelsApi()) {
    return {
      ok: false,
      error: 'PermitStack key is not loaded. Check PERMITSTACK_API_KEY on the server. Do not ask Cayden to paste a key.',
      ...supabaseTargetMeta(),
    };
  }

  if (opts.confirm !== true) {
    const estimate = await estimateShovelsCredits({
      geos: opts.geos,
      place: opts.place,
      city: opts.city,
      state: opts.state,
      geo_level: opts.geo_level,
      date_from: window.date_from,
      date_to: window.date_to,
      property_type: propertyType,
      page_size: opts.page_size ?? 100,
      max_records: maxRecords,
    });
    return {
      ok: true,
      needs_confirm: true,
      confirm_required: true,
      action: 'shovels_pull_calling_list',
      targets,
      max_records: maxRecords,
      proposed_list_name: name,
      owner,
      estimate,
      assistant_instructions:
        'Show resolution (resolved_name / resolved_kind) AND both credit meters. Fix any resolution_failed rows before confirm=true. Prefer "County, ST" or ZIPs for outer-ring DFW. Prefer exclude_national_chains=true and has_phone=true.',
    };
  }

  if (!hasSupabase()) {
    return { ok: false, error: 'Supabase not configured', ...supabaseTargetMeta() };
  }

  // Resolve ALL geos first — never pull (spend) on a bad match.
  const resolved: Array<{ target: GeoTarget; geo: ShovelsGeo }> = [];
  const resolutionErrors: Array<Record<string, unknown>> = [];
  for (const t of targets) {
    try {
      const geo = await resolveShovelsGeo({ kind: t.kind, q: t.q, state: t.state });
      resolved.push({ target: t, geo });
    } catch (err) {
      resolutionErrors.push({
        requested: t,
        error: err instanceof Error ? err.message : String(err),
        detail: err instanceof GeoResolutionError ? { requested: err.requested, resolved: err.resolved } : null,
      });
    }
  }
  if (resolutionErrors.length) {
    return {
      ok: false,
      error: `${resolutionErrors.length} geo(s) failed resolution — no pull credits spent`,
      resolution_errors: resolutionErrors,
      resolved_ok: resolved.map((r) => ({
        requested: r.target,
        resolved_geo_id: r.geo.geo_id,
        resolved_name: r.geo.name,
        resolved_kind: r.geo.kind,
      })),
      ...supabaseTargetMeta(),
      assistant_instructions:
        'Fix failed geos (use "Denton County, TX", geo_level=county, or ZIPs). Re-run. No contractor pages were fetched.',
    };
  }

  const pageSize = opts.page_size ?? 100;
  const state = loadPullState();
  if (opts.reset_cursor === true) {
    for (const { target: t, geo } of resolved) {
      const key = pullJobKey({
        place: t.place,
        geo_id: geo.geo_id,
        date_from: window.date_from,
        date_to: window.date_to,
        property_type: propertyType,
      });
      delete state.jobs[key];
    }
    savePullState(state);
  }

  const byId = new Map<string, ShovelsApiContractor>();
  const perGeo: Array<Record<string, unknown>> = [];
  let pages = 0;
  let creditsSpent = 0;
  let anyTruncated = false;
  const countyErrors: Array<Record<string, unknown>> = [];

  for (const { target: t, geo } of resolved) {
    const remaining = maxRecords - byId.size;
    if (remaining <= 0) {
      anyTruncated = true;
      break;
    }
    const key = pullJobKey({
      place: t.place,
      geo_id: geo.geo_id,
      date_from: window.date_from,
      date_to: window.date_to,
      property_type: propertyType,
    });
    const prior = state.jobs[key];
    const start = startCursorForGeo(opts, prior, pageSize);
    const skipFetch =
      start.restart_reason === 'exhausted' ||
      start.restart_reason === 'marked_done' ||
      start.restart_reason === 'unusable_page_cursor';

    if (skipFetch) {
      const coverage =
        start.restart_reason === 'unusable_page_cursor' ? 'restart_required' : 'exhausted';
      perGeo.push({
        place: t.place,
        requested: t,
        geo,
        fetched: 0,
        unique_added: 0,
        pages: 0,
        truncated: false,
        next_cursor: prior?.cursor ?? null,
        next_offset: start.offset,
        start_offset: start.offset,
        page_size: pageSize,
        total_count: prior?.total_count ?? null,
        resumed_from_cursor: false,
        restart_reason: start.restart_reason,
        start_cursor: start.cursor,
        county_query_empty: false,
        coverage,
        coverage_error:
          start.restart_reason === 'unusable_page_cursor'
            ? 'Stored cursor is a page index without page_size/offset; pass offset or reset_cursor=true.'
            : null,
      });
      continue;
    }

    const pulled = await pullContractorsForGeo({
      geo,
      place: t.place,
      permit_from: window.date_from,
      permit_to: window.date_to,
      property_type: propertyType,
      page_size: pageSize,
      max_records: remaining + start.skip,
      start_cursor: start.cursor,
      fetchPage: opts.fetchPage,
    });
    pages += pulled.pages;
    creditsSpent += pulled.credits_spent;
    if (pulled.truncated) anyTruncated = true;
    const windowItems = pulled.items.slice(start.skip);
    let added = 0;
    for (const item of windowItems) {
      if (byId.has(item.id)) continue;
      byId.set(item.id, item);
      added += 1;
    }
    const nextOffset = start.offset + windowItems.length;
    const totalCount = pulled.total_count ?? prior?.total_count ?? null;
    const countyEmpty = geo.kind === 'county' && pulled.items.length === 0 && !start.resumed && start.offset === 0;
    if (countyEmpty) {
      countyErrors.push({
        place: t.place,
        resolved_geo_id: geo.geo_id,
        resolved_name: geo.name,
        error: countyJurisdictionError(geo),
      });
    }
    const classified = classifyCallingListCoverage({
      countyEmpty,
      totalCount,
      startOffset: start.offset,
      fetchedThisCall: windowItems.length,
      nextOffset,
      truncated: pulled.truncated,
      apiNextCursor: pulled.next_cursor,
    });
    const nextPage = classified.done ? null : pageSkipForOffset(nextOffset, pageSize).cursor;
    state.jobs[key] = {
      place: t.place,
      geo_id: geo.geo_id,
      cursor: nextPage,
      offset: nextOffset,
      page_size: pageSize,
      fetched: nextOffset,
      total_count: totalCount,
      done: classified.done,
      updated_at: new Date().toISOString(),
      window: { ...window, property_type: propertyType },
    };
    savePullState(state);
    perGeo.push({
      place: t.place,
      requested: t,
      geo,
      fetched: windowItems.length,
      unique_added: added,
      pages: pulled.pages,
      truncated: pulled.truncated,
      next_cursor: nextPage,
      next_offset: nextOffset,
      start_offset: start.offset,
      page_size: pageSize,
      total_count: totalCount,
      resumed_from_cursor: start.resumed,
      restart_reason: start.restart_reason,
      start_cursor: start.cursor,
      county_query_empty: countyEmpty,
      coverage: classified.coverage,
      coverage_error: countyEmpty ? countyJurisdictionError(geo) : null,
    });
  }

  if (countyErrors.length && byId.size === 0) {
    return {
      ok: false,
      error: countyErrors.map((e) => e.error).join(' '),
      county_query_empty: true,
      per_geo: perGeo,
      ...supabaseTargetMeta(),
      assistant_instructions:
        'County geos query PermitStack jurisdiction, not city=core. Use a city or ZIP list. This is not silent no_coverage.',
    };
  }

  let hydrateRequests = 0;
  let hydration: HydrationCounters = { ...EMPTY_HYDRATION };
  let idResolve = { resolved: 0, unresolved: 0, requests: 0 };
  const fetchedUnique = byId.size;
  const preHydrate = applyStructuralFilters([...byId.values()], opts);
  byId.clear();
  for (const item of preHydrate) byId.set(item.id, item);

  if (opts.has_phone === true && byId.size) {
    const synthetic = [...byId.values()].filter((c) => isSyntheticContractorId(c.id));
    if (synthetic.length) {
      const resolvedIds = await resolveSyntheticContractorIds([...byId.values()], {
        get: permitstackGet,
      });
      idResolve = {
        resolved: resolvedIds.resolved,
        unresolved: resolvedIds.unresolved,
        requests: resolvedIds.requests,
      };
      creditsSpent += resolvedIds.requests;
      byId.clear();
      for (const item of resolvedIds.items) byId.set(item.id, item);
    }

    const stillSynthetic = [...byId.values()].filter((c) => isSyntheticContractorId(c.id));
    if (stillSynthetic.length === byId.size) {
      return {
        ok: false,
        error:
          'has_phone=true cannot hydrate this geo: permit rows have name-only ids (no contractor_id) and name search did not resolve them. Use a city geo, or pull without has_phone.',
        zip_cannot_hydrate: true,
        unique_before_filters: byId.size,
        id_resolve: idResolve,
        hydration: { ...EMPTY_HYDRATION, hydrated_skipped_synthetic_id: stillSynthetic.length },
        per_geo: perGeo,
        ...supabaseTargetMeta(),
      };
    }

    const hydrateFn = opts.hydrateProfiles ?? hydratePermitstackProfiles;
    const hydrated = await hydrateFn([...byId.values()], {
      max: Math.max(byId.size, maxRecords),
    });
    hydration = {
      attempted: hydrated.attempted,
      hydrated_ok: hydrated.hydrated_ok,
      hydrated_rate_limited: hydrated.hydrated_rate_limited,
      hydrated_failed: hydrated.hydrated_failed,
      hydrated_skipped_synthetic_id: hydrated.hydrated_skipped_synthetic_id,
      requests: hydrated.requests,
      http_attempts: hydrated.http_attempts,
      rate_limited: hydrated.rate_limited,
    };
    hydrateRequests = hydrated.requests;
    creditsSpent += hydrated.requests;
    byId.clear();
    for (const item of hydrated.items) byId.set(item.id, item);
  }

  const filtered = applyContactFilters([...byId.values()], opts);
  const contractors = filtered.map(toContractor);
  const jobId = `permit-live-${randomUUID().slice(0, 8)}`;
  const tags = [
    'permit_parcel',
    'calling_list',
    'shovels_live',
    `owner:${owner}`,
    geoLabel.slice(0, 80),
  ].filter(Boolean);

  const jobErr = await upsertJob({
    id: jobId,
    prompt: name,
    tags,
    requestEstimate: contractors.length,
  });
  if (jobErr) return { ok: false, error: jobErr, ...supabaseTargetMeta() };

  const leads = contractors.map((c) => {
    const chain = nationalChainHit(c);
    return {
      place_id: `shovels:${c.id}`,
      name: c.business_name || c.name || '',
      owner_name: c.name || '',
      email: c.email || c.primary_email || '',
      phone: c.phone || c.primary_phone || '',
      website: c.website || '',
      city: c.address_city || '',
      state: c.address_state || '',
      zip: c.address_zip || '',
      rating: '',
      reviews: c.permit_count != null ? String(c.permit_count) : '',
      permit_count: c.permit_count,
      total_job_value: c.total_job_value,
      national_chain: chain.national_chain ? 'true' : 'false',
      national_chain_reason: chain.reason || '',
      category: c.primary_industry || 'commercial_contractor',
      main_category: 'shovels_live_contractor',
      maps_url: '',
      in_icp: c.email || c.primary_email || c.phone || c.primary_phone ? 'true' : 'false',
      address: c.address_street || '',
      places: (c.places || []).join('|'),
      source_pipeline: 'permit_parcel_shovels_live',
    };
  });

  const { deleted, inserted, error } = await replaceLeads(jobId, tags, leads);
  if (error) return { ok: false, error, ...supabaseTargetMeta() };

  const exportBytes = await upsertExport(jobId, `${jobId}.csv`, contractorsToCsv(contractors));
  const metaErr = await upsertCallingListMeta({
    id: jobId,
    name,
    owner,
    source: 'shovels_live',
    filters: {
      geos: opts.geos ?? null,
      place: opts.place ?? null,
      city: opts.city ?? null,
      state: opts.state ?? null,
      geo_level: opts.geo_level ?? 'auto',
      targets,
      window,
      property_type: propertyType,
      max_records: maxRecords,
      has_phone: opts.has_phone ?? null,
      has_email: opts.has_email ?? null,
      exclude_national_chains: opts.exclude_national_chains ?? null,
      cursor: opts.cursor ?? null,
      offset: opts.offset ?? null,
    },
    row_count: inserted,
  });
  if (metaErr) {
    return {
      ok: false,
      error: `Leads wrote but calling-list catalog failed: ${metaErr}`,
      list_id: jobId,
      ...supabaseTargetMeta(),
    };
  }

  return {
    ok: true,
    ...supabaseTargetMeta(),
    supabase_schema: SCHEMA,
    list: { id: jobId, name, owner, source: 'permitstack_live', row_count: inserted },
    rows_inserted: inserted,
    rows_deleted: deleted,
    unique_before_filters: fetchedUnique,
    unique_after_structural_filters: preHydrate.length,
    unique_after_filters: contractors.length,
    pages_fetched: pages,
    hydrate_requests: hydrateRequests,
    hydration,
    id_resolve: idResolve,
    rate_limited: hydration.rate_limited,
    credits_spent_approx: creditsSpent,
    truncated: anyTruncated,
    max_records: maxRecords,
    per_geo: perGeo,
    export_bytes: exportBytes,
    window: { ...window, property_type: propertyType },
    resume: {
      next_cursors: perGeo.map((g) => ({
        place: g.place,
        next_cursor: g.next_cursor ?? null,
        next_offset: g.next_offset ?? null,
        page_size: g.page_size ?? pageSize,
        resumed_from_cursor: g.resumed_from_cursor ?? false,
        restart_reason: g.restart_reason ?? null,
        coverage: g.coverage ?? null,
      })),
    },
    assistant_instructions: hydration.rate_limited
      ? 'Hydration hit the 60 req/min cap. Counters split ok / rate_limited / failed / skipped_synthetic_id. Re-run the same geo to resume from the stored record offset (new contractors). Do not dump rows into chat.'
      : 'Live PermitStack list is in Supabase. Tell Cayden the list id. Filter with query_calling_list. Hydration runs on this call\'s window after chain/permit filters. A second call on the same geo resumes the stored record offset (safe across page_size). A restart from zero always includes restart_reason. Do not dump rows into chat.',
  };
}
