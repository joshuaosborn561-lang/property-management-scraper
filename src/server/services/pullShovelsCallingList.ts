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
  isCountyQueryEmpty,
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
const HARD_MAX_REQUESTS = 8000;

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
  /**
   * Hydration ceiling. Default equals max_records so spend matches the old
   * "hydrate what we fetched" budget. Raise it to hunt for phones on low-yield geos.
   */
  max_requests?: number;
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

/** Drop ids already hydrated/observed this session. Does not mutate `seen`. */
export function splitSeenContractors(
  items: ShovelsApiContractor[],
  seen: Set<string>,
): { fresh: ShovelsApiContractor[]; duplicates_skipped: number } {
  const fresh: ShovelsApiContractor[] = [];
  let duplicates_skipped = 0;
  for (const item of items) {
    if (!item.id || seen.has(item.id)) {
      duplicates_skipped += 1;
      continue;
    }
    fresh.push(item);
  }
  return { fresh, duplicates_skipped };
}

export function contactFilterYield(uniqueAfterFilters: number, hydrateRequests: number): number | null {
  if (hydrateRequests <= 0) return null;
  return uniqueAfterFilters / hydrateRequests;
}

function addHydration(a: HydrationCounters, b: HydrationCounters): HydrationCounters {
  return {
    attempted: a.attempted + b.attempted,
    hydrated_ok: a.hydrated_ok + b.hydrated_ok,
    hydrated_rate_limited: a.hydrated_rate_limited + b.hydrated_rate_limited,
    hydrated_failed: a.hydrated_failed + b.hydrated_failed,
    hydrated_skipped_synthetic_id: a.hydrated_skipped_synthetic_id + b.hydrated_skipped_synthetic_id,
    requests: a.requests + b.requests,
    http_attempts: a.http_attempts + b.http_attempts,
    rate_limited: a.rate_limited || b.rate_limited,
  };
}

export type CallingListWindowResult = {
  survivors: ShovelsApiContractor[];
  fetched: number;
  unique_added: number;
  duplicates_skipped: number;
  pages: number;
  credits_spent: number;
  truncated: boolean;
  next_cursor: string | null;
  total_count: number | null;
  county_empty: boolean;
  hydration: HydrationCounters;
  id_resolve: { resolved: number; unresolved: number; requests: number };
  seen_ids: string[];
  zip_cannot_hydrate: boolean;
  structural_kept: number;
};

/**
 * Walk provider pages, skip already-seen ids before hydration, and keep going until
 * `max_records` rows survive contact filters, `max_requests` hydrations, or the geo ends.
 */
export async function collectCallingListWindow(opts: {
  geo: ShovelsGeo;
  place: string;
  permit_from: string;
  permit_to: string;
  property_type?: string;
  page_size: number;
  max_records: number;
  max_requests: number;
  start_cursor: string | null;
  first_page_skip: number;
  start_offset: number;
  resumed: boolean;
  seen: Set<string>;
  filters: PullShovelsCallingListInput;
  fetchPage?: typeof shovelsSearchContractorsPage;
  hydrateProfiles?: typeof hydratePermitstackProfiles;
}): Promise<CallingListWindowResult> {
  const survivors: ShovelsApiContractor[] = [];
  let cursor = opts.start_cursor;
  let skip = Math.max(0, opts.first_page_skip);
  let pages = 0;
  let credits = 0;
  let fetched = 0;
  let duplicates_skipped = 0;
  let structuralKept = 0;
  let hydration: HydrationCounters = { ...EMPTY_HYDRATION };
  let idResolve = { resolved: 0, unresolved: 0, requests: 0 };
  let totalCount: number | null = null;
  let truncated = false;
  let first = true;
  let zipCannotHydrate = false;
  const hydrateFn = opts.hydrateProfiles ?? hydratePermitstackProfiles;
  const wantPhone = opts.filters.has_phone === true;

  while (survivors.length < opts.max_records) {
    if (wantPhone && hydration.requests >= opts.max_requests) break;

    const pageCursor = cursor;
    const pulled = await pullContractorsForGeo({
      geo: opts.geo,
      place: opts.place,
      permit_from: opts.permit_from,
      permit_to: opts.permit_to,
      property_type: opts.property_type,
      page_size: opts.page_size,
      max_records: opts.page_size,
      max_pages: 1,
      start_cursor: cursor,
      fetchPage: opts.fetchPage,
    });
    pages += pulled.pages;
    credits += pulled.credits_spent;
    if (pulled.truncated) truncated = true;
    if (totalCount == null && pulled.total_count != null) totalCount = pulled.total_count;

    if (
      first &&
      isCountyQueryEmpty({
        kind: opts.geo.kind,
        itemsOnPage: pulled.items.length,
        offset: opts.start_offset,
        resumed: opts.resumed,
      })
    ) {
      return {
        survivors: [],
        fetched: 0,
        unique_added: 0,
        duplicates_skipped: 0,
        pages,
        credits_spent: credits,
        truncated: false,
        next_cursor: null,
        total_count: totalCount,
        county_empty: true,
        hydration,
        id_resolve: idResolve,
        seen_ids: [...opts.seen],
        zip_cannot_hydrate: false,
        structural_kept: 0,
      };
    }
    first = false;

    let pageItems = pulled.items;
    if (skip > 0) {
      pageItems = pageItems.slice(skip);
      skip = 0;
    }
    fetched += pageItems.length;

    const { fresh, duplicates_skipped: dups } = splitSeenContractors(pageItems, opts.seen);
    duplicates_skipped += dups;

    const structural = applyStructuralFilters(fresh, opts.filters);
    structuralKept += structural.length;
    for (const item of fresh) {
      if (!structural.some((s) => s.id === item.id)) opts.seen.add(item.id);
    }

    let queue = structural;
    let stayedOnPage = false;

    if (wantPhone && queue.length) {
      const synthetic = queue.filter((c) => isSyntheticContractorId(c.id));
      if (synthetic.length) {
        const resolvedIds = await resolveSyntheticContractorIds(queue, { get: permitstackGet });
        idResolve = {
          resolved: idResolve.resolved + resolvedIds.resolved,
          unresolved: idResolve.unresolved + resolvedIds.unresolved,
          requests: idResolve.requests + resolvedIds.requests,
        };
        credits += resolvedIds.requests;
        queue = resolvedIds.items;
      }
      const hydratable = queue.filter((c) => c.id && !isSyntheticContractorId(c.id));
      const stillSynthetic = queue.filter((c) => isSyntheticContractorId(c.id));
      for (const row of stillSynthetic) opts.seen.add(row.id);
      if (hydratable.length === 0 && stillSynthetic.length === queue.length && stillSynthetic.length > 0) {
        zipCannotHydrate = true;
        cursor = pulled.next_cursor;
        if (!cursor || !pulled.items.length) break;
        continue;
      }
      queue = hydratable;
      while (queue.length && survivors.length < opts.max_records && hydration.requests < opts.max_requests) {
        const roomHydrations = opts.max_requests - hydration.requests;
        const roomSurvivors = opts.max_records - survivors.length;
        const batch = queue.slice(0, Math.min(roomHydrations, roomSurvivors, queue.length));
        queue = queue.slice(batch.length);
        const hydrated = await hydrateFn(batch, { max: batch.length });
        hydration = addHydration(hydration, {
          attempted: hydrated.attempted,
          hydrated_ok: hydrated.hydrated_ok,
          hydrated_rate_limited: hydrated.hydrated_rate_limited,
          hydrated_failed: hydrated.hydrated_failed,
          hydrated_skipped_synthetic_id: hydrated.hydrated_skipped_synthetic_id,
          requests: hydrated.requests,
          http_attempts: hydrated.http_attempts,
          rate_limited: hydrated.rate_limited,
        });
        credits += hydrated.requests;
        for (const item of hydrated.items) opts.seen.add(item.id);
        const passed = applyContactFilters(hydrated.items, opts.filters);
        for (const item of passed) {
          if (survivors.length >= opts.max_records) break;
          survivors.push(item);
        }
      }
      if (queue.length) {
        stayedOnPage = true;
        cursor = pageCursor;
      }
    } else {
      const passed = applyContactFilters(queue, opts.filters);
      for (const item of queue) {
        if (!passed.some((p) => p.id === item.id)) opts.seen.add(item.id);
      }
      for (const item of passed) {
        if (survivors.length >= opts.max_records) {
          stayedOnPage = true;
          cursor = pageCursor;
          break;
        }
        opts.seen.add(item.id);
        survivors.push(item);
      }
    }

    if (stayedOnPage) break;
    cursor = pulled.next_cursor;
    if (!cursor || !pulled.items.length) break;
  }

  return {
    survivors,
    fetched,
    unique_added: survivors.length,
    duplicates_skipped,
    pages,
    credits_spent: credits,
    truncated: truncated || survivors.length >= opts.max_records,
    next_cursor: cursor,
    total_count: totalCount,
    county_empty: false,
    hydration,
    id_resolve: idResolve,
    seen_ids: [...opts.seen],
    zip_cannot_hydrate: zipCannotHydrate && survivors.length === 0,
    structural_kept: structuralKept,
  };
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
  seen_ids?: string[];
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
    if (persisted?.seen_ids?.length && persisted.cursor && /^\d+$/.test(persisted.cursor)) {
      return {
        cursor: persisted.cursor,
        skip: 0,
        resumed: true,
        offset: stored,
        restart_reason: null,
      };
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
      max_requests: Math.min(HARD_MAX_REQUESTS, Math.max(1, opts.max_requests ?? maxRecords)),
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
  const maxRequests = Math.min(
    HARD_MAX_REQUESTS,
    Math.max(1, opts.max_requests ?? maxRecords),
  );
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
      const keptSeen = state.jobs[key]?.seen_ids ?? [];
      delete state.jobs[key];
      if (keptSeen.length) {
        state.jobs[key] = {
          place: t.place,
          geo_id: geo.geo_id,
          cursor: null,
          fetched: 0,
          done: false,
          offset: 0,
          page_size: pageSize,
          total_count: null,
          seen_ids: keptSeen,
          updated_at: new Date().toISOString(),
          window: { ...window, property_type: propertyType },
        };
      }
    }
    savePullState(state);
  }

  const byId = new Map<string, ShovelsApiContractor>();
  const perGeo: Array<Record<string, unknown>> = [];
  let pages = 0;
  let creditsSpent = 0;
  let anyTruncated = false;
  const countyErrors: Array<Record<string, unknown>> = [];
  let hydrateRequests = 0;
  let hydration: HydrationCounters = { ...EMPTY_HYDRATION };
  let idResolve = { resolved: 0, unresolved: 0, requests: 0 };
  let duplicatesSkipped = 0;
  let fetchedUnique = 0;
  let structuralKept = 0;
  let zipCannotHydrate = false;

  for (const { target: t, geo } of resolved) {
    const remaining = maxRecords - byId.size;
    const remainingRequests = maxRequests - hydrateRequests;
    if (remaining <= 0 || (opts.has_phone === true && remainingRequests <= 0)) {
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
        duplicates_skipped: 0,
        distinct_contractors_added: 0,
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

    const seen = new Set<string>([...(prior?.seen_ids ?? []), ...byId.keys()]);
    const positionalSkip = seen.size > 0 ? 0 : start.skip;
    const windowResult = await collectCallingListWindow({
      geo,
      place: t.place,
      permit_from: window.date_from,
      permit_to: window.date_to,
      property_type: propertyType,
      page_size: pageSize,
      max_records: remaining,
      max_requests: Math.max(0, remainingRequests),
      start_cursor: start.cursor,
      first_page_skip: positionalSkip,
      start_offset: start.offset,
      resumed: start.resumed,
      seen,
      filters: opts,
      fetchPage: opts.fetchPage,
      hydrateProfiles: opts.hydrateProfiles,
    });
    pages += windowResult.pages;
    creditsSpent += windowResult.credits_spent;
    hydrateRequests += windowResult.hydration.requests;
    hydration = addHydration(hydration, windowResult.hydration);
    idResolve = {
      resolved: idResolve.resolved + windowResult.id_resolve.resolved,
      unresolved: idResolve.unresolved + windowResult.id_resolve.unresolved,
      requests: idResolve.requests + windowResult.id_resolve.requests,
    };
    duplicatesSkipped += windowResult.duplicates_skipped;
    fetchedUnique += windowResult.fetched;
    structuralKept += windowResult.structural_kept;
    if (windowResult.truncated) anyTruncated = true;
    if (windowResult.zip_cannot_hydrate) zipCannotHydrate = true;

    let added = 0;
    for (const item of windowResult.survivors) {
      if (byId.has(item.id)) continue;
      byId.set(item.id, item);
      added += 1;
    }

    const nextOffset = windowResult.seen_ids.length;
    const totalCount = windowResult.total_count ?? prior?.total_count ?? null;
    const countyEmpty = windowResult.county_empty;
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
      fetchedThisCall: windowResult.fetched,
      nextOffset,
      truncated: windowResult.truncated,
      apiNextCursor: windowResult.next_cursor,
    });
    const nextPage = classified.done ? null : windowResult.next_cursor;
    state.jobs[key] = {
      place: t.place,
      geo_id: geo.geo_id,
      cursor: nextPage,
      offset: nextOffset,
      page_size: pageSize,
      fetched: nextOffset,
      total_count: totalCount,
      done: classified.done,
      seen_ids: windowResult.seen_ids,
      updated_at: new Date().toISOString(),
      window: { ...window, property_type: propertyType },
    };
    savePullState(state);
    perGeo.push({
      place: t.place,
      requested: t,
      geo,
      fetched: windowResult.fetched,
      unique_added: added,
      duplicates_skipped: windowResult.duplicates_skipped,
      distinct_contractors_added: added,
      pages: windowResult.pages,
      truncated: windowResult.truncated,
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

  if (zipCannotHydrate && byId.size === 0) {
    return {
      ok: false,
      error:
        'has_phone=true cannot hydrate this geo: permit rows have name-only ids (no contractor_id) and name search did not resolve them. Use a city geo, or pull without has_phone.',
      zip_cannot_hydrate: true,
      unique_before_filters: fetchedUnique,
      id_resolve: idResolve,
      hydration,
      per_geo: perGeo,
      ...supabaseTargetMeta(),
    };
  }

  const contractors = [...byId.values()].map(toContractor);
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
      max_requests: maxRequests,
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
    duplicates_skipped: duplicatesSkipped,
    distinct_contractors_added: contractors.length,
    unique_before_filters: fetchedUnique,
    unique_after_structural_filters: structuralKept,
    unique_after_filters: contractors.length,
    contact_filter_yield: contactFilterYield(contractors.length, hydrateRequests),
    pages_fetched: pages,
    hydrate_requests: hydrateRequests,
    hydration,
    id_resolve: idResolve,
    rate_limited: hydration.rate_limited,
    credits_spent_approx: creditsSpent,
    truncated: anyTruncated,
    max_records: maxRecords,
    max_requests: maxRequests,
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
      ? 'Hydration hit the 60 req/min cap. Counters split ok / rate_limited / failed / skipped_synthetic_id. Re-run the same geo to resume unseen contractors (seen_ids skip already-hydrated). Do not dump rows into chat.'
      : 'Live PermitStack list is in Supabase. Tell Cayden the list id. Filter with query_calling_list. max_records is surviving rows after contact filters; max_requests caps hydration. Duplicates are skipped before hydration (duplicates_skipped / distinct_contractors_added). Re-run the same geo to continue; already-seen ids are not hydrated again. A restart from zero always includes restart_reason. Do not dump rows into chat.',
  };
}
