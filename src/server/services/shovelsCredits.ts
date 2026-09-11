import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  GeoResolutionError,
  hasShovelsApi,
  probeContractorCount,
  resolveShovelsGeo,
  getShovelsUsage,
  classifyProbeCoverage,
  type ShovelsGeo,
} from '../lib/shovels.js';
import type { ContractorQuery } from './shovelsContractors.js';
import { countMatchingShovelsContractors, loadShovelsContractors } from './shovelsContractors.js';
import { resolveGeoTargets, type GeoLevelHint, type GeoTarget } from './shovelsGeoTargets.js';

/** How the last in-repo DFW commercial pull actually billed. */
export const LAST_DFW_JOB = {
  date_from: '2025-08-01',
  date_to: '2026-08-07',
  filter: 'property_type=commercial',
  page_size: 100,
  requests_used: 67,
  unique_contractors: 6124,
  pages: {
    Dallas: 43,
    Fort_Worth: 22,
    Rockwall_County: 1,
  },
  fetched: {
    Dallas: 4279,
    Fort_Worth: 2192,
    Rockwall_County: 29,
  },
} as const;

export interface ShovelsCreditEstimateInput extends ContractorQuery {
  max_records?: number;
  date_from?: string;
  date_to?: string;
  property_type?: string;
  page_size?: number;
  /** Any US city/county/zip/state. Prefer "Denton County, TX; Collin County, TX" or ZIPs. */
  geos?: string;
  /** Force resolution level for every token. */
  geo_level?: GeoLevelHint;
  /** Resolve geos only — no include_count probes, no credit spend. */
  resolve_only?: boolean;
}

function loadLastJobMeta(): Record<string, unknown> {
  const p = join(process.cwd(), 'data', 'shovels_commercial_contractors', 'summary.json');
  if (!existsSync(p)) return LAST_DFW_JOB;
  try {
    return { ...LAST_DFW_JOB, ...(JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>) };
  } catch {
    return LAST_DFW_JOB;
  }
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

function pagesFor(count: number, pageSize: number): number {
  if (count <= 0) return 0;
  return Math.ceil(count / pageSize);
}

function historicalPages(place: string): { pages: number; fetched: number } | null {
  if (place === 'Dallas') return { pages: LAST_DFW_JOB.pages.Dallas, fetched: LAST_DFW_JOB.fetched.Dallas };
  if (place === 'Fort_Worth') return { pages: LAST_DFW_JOB.pages.Fort_Worth, fetched: LAST_DFW_JOB.fetched.Fort_Worth };
  if (place === 'Rockwall_County') {
    return { pages: LAST_DFW_JOB.pages.Rockwall_County, fetched: LAST_DFW_JOB.fetched.Rockwall_County };
  }
  return null;
}

type ResolvedRow = {
  place: string;
  requested: GeoTarget;
  ok: boolean;
  resolved_geo_id: string | null;
  resolved_name: string | null;
  resolved_kind: string | null;
  resolved_state: string | null;
  geo: ShovelsGeo | null;
  error: string | null;
};

async function resolveAllTargets(targets: GeoTarget[]): Promise<ResolvedRow[]> {
  const rows: ResolvedRow[] = [];
  for (const t of targets) {
    try {
      const geo = await resolveShovelsGeo({ kind: t.kind, q: t.q, state: t.state });
      rows.push({
        place: t.place,
        requested: t,
        ok: true,
        resolved_geo_id: geo.geo_id,
        resolved_name: geo.name,
        resolved_kind: geo.kind,
        resolved_state: geo.state ?? null,
        geo,
        error: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail =
        err instanceof GeoResolutionError
          ? { requested: err.requested, resolved: err.resolved }
          : null;
      rows.push({
        place: t.place,
        requested: t,
        ok: false,
        resolved_geo_id: null,
        resolved_name: null,
        resolved_kind: null,
        resolved_state: null,
        geo: null,
        error: detail ? `${msg} | detail=${JSON.stringify(detail)}` : msg,
      });
    }
  }
  return rows;
}

/**
 * Accurate live estimate: resolve ALL geos first (fail loudly, no probe credits
 * on bad matches), then include_count probe only the clean ones.
 * resolve_only=true skips probes entirely.
 */
export async function estimateShovelsCredits(q: ShovelsCreditEstimateInput = {}) {
  const pageSize = Math.min(100, Math.max(1, q.page_size ?? 100));
  const window = {
    date_from: q.date_from || defaultWindow().date_from,
    date_to: q.date_to || defaultWindow().date_to,
  };
  const propertyType = q.property_type || 'commercial';
  const targets = resolveGeoTargets(q);
  const cachedMatching = countMatchingShovelsContractors(q);
  const lastJob = loadLastJobMeta();
  const resolveOnly = q.resolve_only === true;

  let usage: Record<string, unknown> | null = null;
  let live = false;
  let liveError: string | null = null;
  let probeCredits = 0;
  let headersCreditsRemaining: number | null = null;
  let headersCreditsLimit: number | null = null;

  const geos: Array<Record<string, unknown>> = [];
  let resolution: ResolvedRow[] = [];

  if (hasShovelsApi()) {
    live = true;
    try {
      usage = await getShovelsUsage();
      resolution = await resolveAllTargets(targets);

      if (resolveOnly) {
        for (const r of resolution) {
          geos.push({
            place: r.place,
            requested: r.requested,
            ok: r.ok,
            resolved_geo_id: r.resolved_geo_id,
            resolved_name: r.resolved_name,
            resolved_kind: r.resolved_kind,
            resolved_state: r.resolved_state,
            geo: r.geo,
            error: r.error,
            probed: false,
            total_count: null,
            coverage: r.ok ? 'resolve_only' : 'resolution_failed',
          });
        }
      } else {
        const failed = resolution.filter((r) => !r.ok);
        const okRows = resolution.filter((r) => r.ok && r.geo);

        // Surface failures first — do not probe them.
        for (const r of failed) {
          geos.push({
            place: r.place,
            requested: r.requested,
            ok: false,
            resolved_geo_id: null,
            resolved_name: null,
            resolved_kind: null,
            resolved_state: null,
            geo: null,
            error: r.error,
            probed: false,
            total_count: null,
            coverage: 'resolution_failed',
            probe_credits: 0,
          });
        }

        for (const r of okRows) {
          const probe = await probeContractorCount({
            geo: r.geo!,
            permit_from: window.date_from,
            permit_to: window.date_to,
            property_type: propertyType,
          });
          const hist = historicalPages(r.place);
          const classified = classifyProbeCoverage(probe, pageSize);
          const pages = classified.estimated_pages;
          probeCredits += probe.headers.credits_request ?? 1;
          if (probe.headers.credits_remaining != null) {
            headersCreditsRemaining = probe.headers.credits_remaining;
          }
          if (probe.headers.credits_limit != null) {
            headersCreditsLimit = probe.headers.credits_limit;
          }
          geos.push({
            place: r.place,
            requested: r.requested,
            ok: true,
            resolved_geo_id: r.resolved_geo_id,
            resolved_name: r.resolved_name,
            resolved_kind: r.resolved_kind,
            resolved_state: r.resolved_state,
            geo: r.geo,
            error: null,
            probed: true,
            total_count: probe.total_count,
            total_count_raw: probe.total_count_raw,
            count_relation: probe.count_relation,
            items_on_probe: probe.items_on_probe,
            page_size_returned: probe.page_size_returned,
            has_more: probe.has_more,
            count_unreliable: probe.count_unreliable,
            estimated_pages: classified.estimated_pages,
            estimated_credits: pages,
            probe_credits: probe.headers.credits_request,
            credits_remaining_after: probe.headers.credits_remaining,
            no_coverage: probe.no_coverage,
            county_query_empty: classified.coverage === 'county_query_empty',
            coverage_error: probe.coverage_error ?? null,
            coverage: classified.coverage,
            last_job_pages: hist?.pages ?? null,
            last_job_fetched: hist?.fetched ?? null,
            /** Null when the probe returned no contractor rows (county permit totals are not contractors). */
            contractor_count: classified.contractor_count,
            permit_total: probe.total_count,
          });
        }
      }
    } catch (err) {
      live = false;
      liveError = err instanceof Error ? err.message : String(err);
    }
  }

  if (!geos.length) {
    for (const t of targets) {
      const hist = historicalPages(t.place);
      const fetched = hist?.fetched ?? 0;
      const pages = hist?.pages ?? pagesFor(fetched, pageSize);
      geos.push({
        place: t.place,
        requested: t,
        ok: Boolean(hist),
        resolved_geo_id: null,
        resolved_name: null,
        resolved_kind: t.kind,
        resolved_state: t.state ?? null,
        geo: null,
        error: hist ? null : 'No API key / no historical pages for this place',
        probed: false,
        total_count: fetched,
        count_relation: hist ? 'last_job' : null,
        estimated_pages: pages,
        estimated_credits: pages,
        probe_credits: 0,
        coverage: hist ? 'last_job' : 'unknown',
      });
    }
  }

  const probed = geos.filter((g) => g.probed === true);
  const contractorCounts = probed
    .map((g) => ('contractor_count' in g ? (g as { contractor_count?: number | null }).contractor_count : null));
  const hasContractorCount = contractorCounts.some((n) => n != null);
  const contractors = contractorCounts.reduce((n: number, c) => n + (typeof c === 'number' ? c : 0), 0);
  let pages = probed.reduce((n, g) => n + Number(g.estimated_credits || 0), 0);
  let companies = contractors;
  if (q.max_records && q.max_records > 0) {
    pages = Math.min(pages, pagesFor(q.max_records, pageSize));
    companies = Math.min(companies, q.max_records);
  }

  const resolutionFailed = geos.filter((g) => g.ok === false);
  const noCoverage = geos.filter((g) => g.coverage === 'no_coverage');
  const countyEmpty = geos.filter((g) => g.coverage === 'county_query_empty');
  const places = targets.map((t) => t.place).join(', ');

  const creditsUsed =
    usage && typeof usage.credits_used === 'number'
      ? usage.credits_used
      : null;
  const creditsRemaining =
    headersCreditsRemaining ??
    (usage && typeof usage.credits_remaining === 'number' ? usage.credits_remaining : null);
  const creditsLimit =
    headersCreditsLimit ??
    (usage && typeof usage.credits_limit === 'number' ? usage.credits_limit : null);

  return {
    ok: resolutionFailed.length === 0 || resolveOnly || probed.length > 0,
    resolve_only: resolveOnly,
    source: resolveOnly
      ? 'permitstack_resolve_only'
      : live
        ? 'permitstack_contractor_search'
        : liveError
          ? 'last_job_fallback'
          : 'last_job_no_api_key',
    live_api: live,
    provider: 'permitstack',
    shovels_api_configured: hasShovelsApi(),
    permitstack_api_configured: hasShovelsApi(),
    key_hint: hasShovelsApi()
      ? null
      : 'PermitStack key missing from this process. It should come from PERMITSTACK_API_KEY — do not ask Cayden to rotate keys.',
    live_error: liveError,
    spends_shovels_credits: live && !resolveOnly,
    probe_credits_spent: resolveOnly ? 0 : live ? probeCredits : 0,
    credits_used: creditsUsed,
    credits_remaining: creditsRemaining,
    credits_limit: creditsLimit,
    resolution_failed_count: resolutionFailed.length,
    no_coverage_count: noCoverage.length,
    window: { ...window, property_type: propertyType, page_size: pageSize },
    geos,
    contractors: resolveOnly ? null : hasContractorCount ? contractors : probed.length ? null : contractors,
    billing: {
      provider: 'permitstack',
      unit: '1 HTTP request = 1 contractor-search page (per_page up to 100) or 1 profile hydration',
      free_trial: 'PermitStack free tier is 100 requests/day. A per_page=1 probe still returns the full total and costs 1 request.',
      paid: 'Paid plans raise the daily request cap. Contact fields (phone/email) are on Developer and up via GET /v1/contractors/{id}.',
      docs: 'https://permit-stack.com/docs/  OpenAPI: https://api.permit-stack.com/public-openapi.json',
    },
    credits: {
      cached_query: 0,
      estimated_requests: resolveOnly ? 0 : pages,
      free_tier_pages: resolveOnly ? 0 : pages,
      paid_tier_companies: resolveOnly ? 0 : companies,
      estimate: resolveOnly ? 0 : pages,
      used: creditsUsed,
      remaining: creditsRemaining,
      limit: creditsLimit,
      unit_free: '1 request = 1 PermitStack HTTP call (search page)',
      unit_paid: 'Same — PermitStack does not bill per contractor record',
    },
    last_dfw_job: {
      requests_used: lastJob.requests_used_this_job ?? LAST_DFW_JOB.requests_used,
      unique_contractors: lastJob.unique_contractors ?? LAST_DFW_JOB.unique_contractors,
      pages: LAST_DFW_JOB.pages,
      note: 'Dallas + Tarrant was 65 pages / 6,471 rows. Under 500 only matches request/page billing (free/trial). Paid would have been ~6,471 company-credits.',
    },
    usage,
    cached_file_size: loadShovelsContractors().length,
    cached_matching: cachedMatching,
    filters: {
      q: q.q ?? null,
      place: q.place ?? null,
      geos: q.geos ?? null,
      city: q.city ?? null,
      state: q.state ?? null,
      geo_level: q.geo_level ?? 'auto',
      resolve_only: resolveOnly,
    },
    explanation: resolveOnly
      ? `Resolved ${targets.length} geo(s) with 0 probe credits. ${resolutionFailed.length} failed. Fix failures before probing.`
      : `Pull for ${places || 'default geos'}: ~${pages} pages / ~${companies} companies. ${resolutionFailed.length} resolution failure(s) were NOT probed. ${countyEmpty.length} county geo(s) returned 0 from jurisdiction search (not a silent city miss). ${noCoverage.length} geo(s) report no_coverage.`,
    assistant_instructions: resolveOnly
      ? 'Show each resolved_name / resolved_kind / resolved_geo_id. If any error, fix the geos string (use "Denton County, TX" — not "Denton County; TX; …" with bare state slots — or geo_level=county, or a ZIP list) before probing. Do not probe until resolution is clean.'
      : hasShovelsApi()
        ? 'PermitStack bills per HTTP request (not per contractor). Quote credits.estimated_requests (search pages). Profile hydration for phone/email is extra 1 request each and is Developer-plan. Cached DFW tools still cost 0.'
        : 'PermitStack key is not loaded. Check PERMITSTACK_API_KEY on the server. Do not ask Cayden to paste a key.',
  };
}
