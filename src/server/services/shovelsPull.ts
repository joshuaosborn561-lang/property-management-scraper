import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hasShovelsApi,
  mapShovelsApiContractor,
  parseTotalCount,
  pullContractorsForGeo,
  resolveShovelsGeo,
  shovelsSearchContractorsPage,
  type ShovelsApiContractor,
  type ShovelsGeo,
  type ShovelsHeaders,
} from '../lib/shovels.js';
import {
  contractorsDataDir,
  loadShovelsContractors,
  setContractorsDataDirForTests,
  upsertShovelsContractorsIntoStore,
  type ShovelsContractor,
} from './shovelsContractors.js';
import { resolveGeoTargets, type GeoLevelHint, type GeoTarget } from './shovelsGeoTargets.js';

export { setContractorsDataDirForTests };

export interface ShovelsPullInput {
  geos?: string;
  place?: string;
  city?: string;
  state?: string;
  geo_level?: GeoLevelHint;
  property_type?: string;
  date_from?: string;
  date_to?: string;
  /** Max page size (1–100). Default 100 — one request per page on trial. */
  page_size?: number;
  /** Hard ceiling. Checked before each request. Required. */
  max_records: number;
  /** Resolve + optional count only — no page fetches, no store writes. */
  dry_run?: boolean;
  /** Abort if credits_remaining drops below this (default 5). */
  min_credits_remaining?: number;
  /** Clear stored cursors for these geos and start fresh. */
  reset_cursor?: boolean;
  /** Injectable page fetch for fixture tests — never hits live API in tests. */
  fetchPage?: typeof shovelsSearchContractorsPage;
  /** Injectable geo resolver for tests. */
  resolveGeo?: typeof resolveShovelsGeo;
}

type PullCursorState = {
  jobs: Record<
    string,
    {
      place: string;
      geo_id: string;
      cursor: string | null;
      fetched: number;
      done: boolean;
      updated_at: string;
      window: { date_from: string; date_to: string; property_type: string };
    }
  >;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultWindow() {
  const to = new Date();
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  return { date_from: isoDate(from), date_to: isoDate(to) };
}

function stateDir(): string {
  return contractorsDataDir();
}

function statePath(): string {
  return join(stateDir(), 'pull_state.json');
}

export function loadPullState(): PullCursorState {
  const p = statePath();
  if (!existsSync(p)) return { jobs: {} };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as PullCursorState;
    return raw && typeof raw === 'object' && raw.jobs ? raw : { jobs: {} };
  } catch {
    return { jobs: {} };
  }
}

export function savePullState(state: PullCursorState): void {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
}

export function pullJobKey(opts: {
  place: string;
  geo_id: string;
  date_from: string;
  date_to: string;
  property_type: string;
}): string {
  return [opts.place, opts.geo_id, opts.date_from, opts.date_to, opts.property_type].join('|');
}

function toStoreRow(c: ShovelsApiContractor): ShovelsContractor {
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

/**
 * Live Shovels pull → on-disk contractor store used by permits_contractors_*.
 * Counts-only response. Fixture-injectable fetchPage for tests (no live spend).
 */
export async function shovelsPull(opts: ShovelsPullInput) {
  if (opts.max_records == null || !Number.isFinite(opts.max_records) || opts.max_records < 1) {
    return {
      ok: false,
      error: 'max_records is required (hard ceiling, checked before each request)',
    };
  }

  const maxRecords = Math.min(50_000, Math.max(1, Math.floor(opts.max_records)));
  const pageSize = Math.min(100, Math.max(1, opts.page_size ?? 100));
  const minCredits = opts.min_credits_remaining ?? 5;
  const dryRun = opts.dry_run === true;
  const propertyType = opts.property_type || 'commercial';
  const window = {
    date_from: opts.date_from || defaultWindow().date_from,
    date_to: opts.date_to || defaultWindow().date_to,
  };
  const targets = resolveGeoTargets(opts);
  const resolveGeo = opts.resolveGeo ?? resolveShovelsGeo;
  const fetchPage = opts.fetchPage ?? shovelsSearchContractorsPage;

  if (!dryRun && !opts.fetchPage && !hasShovelsApi()) {
    return {
      ok: false,
      error: 'No PermitStack API key. Set one with permitstack_set_api_key (alias shovels_set_api_key, confirm=true).',
    };
  }

  type Resolved = {
    target: GeoTarget;
    ok: boolean;
    geo: ShovelsGeo | null;
    error: string | null;
    resolved_geo_id: string | null;
    resolved_name: string | null;
    resolved_kind: string | null;
  };

  const resolved: Resolved[] = [];
  for (const t of targets) {
    try {
      const geo = await resolveGeo({ kind: t.kind, q: t.q, state: t.state });
      resolved.push({
        target: t,
        ok: true,
        geo,
        error: null,
        resolved_geo_id: geo.geo_id,
        resolved_name: geo.name,
        resolved_kind: geo.kind,
      });
    } catch (err) {
      resolved.push({
        target: t,
        ok: false,
        geo: null,
        error: err instanceof Error ? err.message : String(err),
        resolved_geo_id: null,
        resolved_name: null,
        resolved_kind: null,
      });
    }
  }

  const failed = resolved.filter((r) => !r.ok);
  if (dryRun) {
    // Optional cheap include_count per ok geo via size=1 — but dry_run must NOT spend.
    // Spec: "resolves geos and returns counts without fetching or spending."
    return {
      ok: failed.length === 0,
      dry_run: true,
      spends_shovels_credits: false,
      requests_used: 0,
      requests_remaining: null,
      credits_used: null,
      credits_remaining: null,
      max_records: maxRecords,
      page_size: pageSize,
      window: { ...window, property_type: propertyType },
      geos: resolved.map((r) => ({
        place: r.target.place,
        requested: r.target,
        ok: r.ok,
        resolved_geo_id: r.resolved_geo_id,
        resolved_name: r.resolved_name,
        resolved_kind: r.resolved_kind,
        error: r.error,
        coverage: r.ok ? 'resolved' : 'resolution_failed',
      })),
      records_fetched: 0,
      records_written: 0,
      duplicates_skipped: 0,
      store_total: loadShovelsContractors().length,
      assistant_instructions:
        'dry_run only resolved geos (0 credits). Fix any resolution_failed, then shovels_pull with dry_run=false and max_records set. Prefer page_size=100 on trial keys.',
    };
  }

  if (failed.length) {
    return {
      ok: false,
      error: `${failed.length} geo(s) failed resolution — no pages fetched`,
      geos: resolved.map((r) => ({
        place: r.target.place,
        requested: r.target,
        ok: r.ok,
        resolved_geo_id: r.resolved_geo_id,
        resolved_name: r.resolved_name,
        resolved_kind: r.resolved_kind,
        error: r.error,
      })),
      records_fetched: 0,
      records_written: 0,
      requests_used: 0,
      requests_remaining: null,
    };
  }

  const state = loadPullState();
  if (opts.reset_cursor) {
    for (const r of resolved) {
      if (!r.geo) continue;
      const key = pullJobKey({
        place: r.target.place,
        geo_id: r.geo.geo_id,
        date_from: window.date_from,
        date_to: window.date_to,
        property_type: propertyType,
      });
      delete state.jobs[key];
    }
    savePullState(state);
  }

  const allFetched: ShovelsApiContractor[] = [];
  const perGeo: Array<Record<string, unknown>> = [];
  let requestsUsed = 0;
  let creditsSpent = 0;
  let creditsRemaining: number | null = null;
  let creditsLimit: number | null = null;
  let budgetLeft = maxRecords;
  let stoppedEarly: string | null = null;

  for (const r of resolved) {
    if (!r.geo) continue;
    if (budgetLeft <= 0) {
      stoppedEarly = 'max_records';
      perGeo.push({
        place: r.target.place,
        resolved_geo_id: r.resolved_geo_id,
        resolved_name: r.resolved_name,
        skipped: true,
        reason: 'max_records_exhausted',
      });
      continue;
    }

    const key = pullJobKey({
      place: r.target.place,
      geo_id: r.geo.geo_id,
      date_from: window.date_from,
      date_to: window.date_to,
      property_type: propertyType,
    });
    const prior = state.jobs[key];
    const startCursor = prior && !prior.done ? prior.cursor : null;

    const pulled = await pullContractorsForGeo({
      geo: r.geo,
      place: r.target.place,
      permit_from: window.date_from,
      permit_to: window.date_to,
      property_type: propertyType,
      page_size: pageSize,
      max_records: budgetLeft,
      start_cursor: startCursor,
      min_credits_remaining: minCredits,
      fetchPage,
    });

    requestsUsed += pulled.pages;
    creditsSpent += pulled.credits_spent;
    if (pulled.headers_last?.credits_remaining != null) {
      creditsRemaining = pulled.headers_last.credits_remaining;
    }
    if (pulled.headers_last?.credits_limit != null) {
      creditsLimit = pulled.headers_last.credits_limit;
    }

    allFetched.push(...pulled.items);
    budgetLeft = Math.max(0, maxRecords - allFetched.length);

    const done = !pulled.truncated && !pulled.next_cursor;
    state.jobs[key] = {
      place: r.target.place,
      geo_id: r.geo.geo_id,
      cursor: pulled.next_cursor,
      fetched: (prior?.fetched ?? 0) + pulled.items.length,
      done,
      updated_at: new Date().toISOString(),
      window: { ...window, property_type: propertyType },
    };
    savePullState(state);

    perGeo.push({
      place: r.target.place,
      requested: r.target,
      resolved_geo_id: r.resolved_geo_id,
      resolved_name: r.resolved_name,
      resolved_kind: r.resolved_kind,
      fetched: pulled.items.length,
      pages: pulled.pages,
      truncated: pulled.truncated,
      next_cursor: pulled.next_cursor,
      resumed_from_cursor: Boolean(startCursor),
      stopped_reason: pulled.stopped_reason,
      credits_remaining_after: pulled.headers_last?.credits_remaining ?? null,
      coverage:
        pulled.stopped_reason === 'empty' || pulled.items.length === 0 ? 'no_coverage' : 'ok',
    });

    if (pulled.stopped_reason === 'credit_floor') {
      stoppedEarly = 'credit_floor';
      break;
    }
    if (pulled.headers_last?.credits_remaining != null && pulled.headers_last.credits_remaining < minCredits) {
      stoppedEarly = 'credit_floor';
      return {
        ok: false,
        error: `credits_remaining ${pulled.headers_last.credits_remaining} below floor ${minCredits} — stopped to protect the key`,
        dry_run: false,
        spends_shovels_credits: true,
        requests_used: requestsUsed,
        requests_remaining: creditsRemaining,
        credits_used: creditsSpent,
        credits_remaining: creditsRemaining,
        credits_limit: creditsLimit,
        max_records: maxRecords,
        page_size: pageSize,
        window: { ...window, property_type: propertyType },
        geos: perGeo,
        records_fetched: allFetched.length,
        records_written: 0,
        duplicates_skipped: 0,
        store_total: loadShovelsContractors().length,
        resume: true,
        assistant_instructions:
          'Credit floor hit. Cursor(s) saved in pull_state.json — re-run shovels_pull to resume without re-paying finished pages.',
      };
    }
  }

  const storeRows = allFetched.map(toStoreRow);
  const upsert =
    storeRows.length > 0
      ? upsertShovelsContractorsIntoStore(storeRows)
      : {
          written: 0,
          inserted: 0,
          updated: 0,
          duplicates_skipped: 0,
          total_after: loadShovelsContractors().length,
          path: null as string | null,
        };

  return {
    ok: true,
    dry_run: false,
    spends_shovels_credits: true,
    requests_used: requestsUsed,
    requests_remaining: creditsRemaining,
    credits_used: creditsSpent,
    credits_remaining: creditsRemaining,
    credits_limit: creditsLimit,
    max_records: maxRecords,
    page_size: pageSize,
    stopped_early: stoppedEarly,
    window: { ...window, property_type: propertyType },
    geos: perGeo,
    records_fetched: allFetched.length,
    records_written: upsert.written,
    records_inserted: upsert.inserted,
    records_updated: upsert.updated,
    duplicates_skipped: upsert.duplicates_skipped,
    store_total: upsert.total_after,
    store_path: upsert.path,
    resume_state: statePath(),
    assistant_instructions:
      'Counts only — no rows dumped. permits_contractors_query(place=…) now sees pulled places. Re-run to resume truncated geos (cursors in pull_state.json). On trial keys keep page_size=100.',
  };
}

/** Test helper: build a fixture page sequence without touching the network. */
export function makeFixtureFetchPage(
  pages: Array<{
    items: Record<string, unknown>[];
    next_cursor?: string | null;
    total_count?: unknown;
    credits_request?: number;
    credits_remaining?: number;
    credits_limit?: number;
  }>,
): typeof shovelsSearchContractorsPage {
  let i = 0;
  return async () => {
    const page = pages[Math.min(i, pages.length - 1)]!;
    i += 1;
    const headers: ShovelsHeaders = {
      credits_request: page.credits_request ?? page.items.length,
      credits_limit: page.credits_limit ?? 500,
      credits_remaining: page.credits_remaining ?? 100,
    };
    return {
      items: page.items,
      next_cursor: page.next_cursor ?? null,
      total_count_raw: page.total_count ?? { value: page.items.length, relation: 'eq' },
      headers,
    };
  };
}

export { mapShovelsApiContractor, parseTotalCount };
