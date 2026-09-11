import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ShovelsApiContractor, ShovelsGeo } from '../lib/shovels.js';
import { classifyProbeCoverage, isCountyQueryEmpty } from '../lib/shovels.js';
import {
  applyContactFilters,
  applyStructuralFilters,
  classifyCallingListCoverage,
  collectCallingListWindow,
  contactFilterYield,
  pageSkipForOffset,
  recordOffsetFromJob,
  splitSeenContractors,
  startCursorForGeo,
} from './pullShovelsCallingList.js';

function row(id: string, extra: Partial<ShovelsApiContractor> = {}): ShovelsApiContractor {
  return {
    id,
    name: id,
    business_name: id,
    dba: null,
    phone: extra.phone ?? null,
    primary_phone: extra.primary_phone ?? null,
    email: extra.email ?? null,
    primary_email: extra.primary_email ?? null,
    website: null,
    linkedin_url: null,
    employee_count: null,
    address_street: null,
    address_city: 'Tampa',
    address_state: 'FL',
    address_zip: null,
    places: ['Tampa'],
    permit_count: extra.permit_count ?? 10,
    total_job_value: null,
    primary_industry: null,
    business_type: null,
    ...extra,
  };
}

describe('calling-list filters before hydration', () => {
  it('drops national chains and permit-count misses without needing a phone', () => {
    const items = [
      row('local', { permit_count: 12 }),
      row('mccarthy', { business_name: 'McCarthy Building Companies', permit_count: 800 }),
      row('thin', { permit_count: 1 }),
    ];
    const kept = applyStructuralFilters(items, {
      exclude_national_chains: true,
      min_permit_count: 5,
    });
    assert.deepEqual(
      kept.map((c) => c.id),
      ['local'],
    );
  });

  it('leaves has_phone for after hydration', () => {
    const items = [row('a', { permit_count: 9 }), row('b', { phone: '8135550100', permit_count: 9 })];
    const structural = applyStructuralFilters(items, { has_phone: true });
    assert.equal(structural.length, 2);
    const after = applyContactFilters(structural, { has_phone: true });
    assert.deepEqual(
      after.map((c) => c.id),
      ['b'],
    );
  });
});

describe('calling-list resume cursor', () => {
  it('uses an explicit cursor over stored state', () => {
    const start = startCursorForGeo(
      { cursor: '4' },
      { cursor: '2', done: false, fetched: 100 },
      100,
    );
    assert.deepEqual(start, {
      cursor: '4',
      skip: 0,
      resumed: false,
      offset: 300,
      restart_reason: 'explicit_cursor',
    });
  });

  it('turns offset into a page + skip so a second window is not page 1', () => {
    const start = startCursorForGeo({ offset: 200 }, undefined, 100);
    assert.deepEqual(start, {
      cursor: '3',
      skip: 0,
      resumed: false,
      offset: 200,
      restart_reason: 'explicit_offset',
    });
  });

  it('resumes from stored record offset, not a page index', () => {
    const start = startCursorForGeo({}, { cursor: '3', done: false, fetched: 200 }, 100);
    assert.deepEqual(start, {
      cursor: '3',
      skip: 0,
      resumed: true,
      offset: 200,
      restart_reason: null,
    });
  });

  it('recomputes page+skip when page_size changes (40 x3 then 100 continues at ~121)', () => {
    const afterThree = startCursorForGeo({}, { offset: 120, fetched: 120, done: false, page_size: 40 }, 100);
    assert.deepEqual(afterThree, {
      cursor: '2',
      skip: 20,
      resumed: true,
      offset: 120,
      restart_reason: null,
    });
  });

  it('converts a legacy page cursor using the stored page_size', () => {
    assert.equal(recordOffsetFromJob({ cursor: '12', page_size: 40, done: false }), 440);
    const start = startCursorForGeo({}, { cursor: '12', page_size: 40, done: false }, 100);
    assert.equal(start.offset, 440);
    assert.equal(start.cursor, '5');
    assert.equal(start.skip, 40);
    assert.equal(start.resumed, true);
  });

  it('does not reuse a bare page index when page_size is unknown', () => {
    const start = startCursorForGeo({}, { cursor: '12', done: false }, 100);
    assert.deepEqual(start, {
      cursor: null,
      skip: 0,
      resumed: false,
      offset: 0,
      restart_reason: 'unusable_page_cursor',
    });
  });

  it('does not resume a completed job when offset is at total_count', () => {
    const start = startCursorForGeo(
      {},
      { cursor: null, done: true, fetched: 1030, offset: 1030, total_count: 1030 },
      100,
    );
    assert.deepEqual(start, {
      cursor: null,
      skip: 0,
      resumed: false,
      offset: 1030,
      restart_reason: 'exhausted',
    });
  });

  it('resumes a done job that has no total_count from fetched (unsticks a false complete)', () => {
    const start = startCursorForGeo({}, { cursor: null, done: true, fetched: 440 }, 40);
    assert.equal(start.resumed, true);
    assert.equal(start.offset, 440);
    assert.equal(start.restart_reason, null);
  });

  it('recovers a false-complete geo when fetched is below total_count', () => {
    const start = startCursorForGeo(
      {},
      { cursor: null, done: true, fetched: 440, offset: 440, total_count: 1030 },
      40,
    );
    assert.equal(start.resumed, true);
    assert.equal(start.offset, 440);
    assert.equal(start.cursor, '12');
    assert.equal(start.skip, 0);
    assert.equal(start.restart_reason, null);
  });

  it('surfaces reset_cursor instead of looking like a fresh first pull', () => {
    const start = startCursorForGeo({ reset_cursor: true }, { cursor: '4', fetched: 120, done: false }, 40);
    assert.equal(start.restart_reason, 'reset_cursor');
    assert.equal(start.resumed, false);
    assert.equal(start.offset, 0);
  });
});

describe('calling-list coverage vs done', () => {
  it('does not mark a geo done on an empty page while offset < total_count', () => {
    const got = classifyCallingListCoverage({
      countyEmpty: false,
      totalCount: 1030,
      startOffset: 440,
      fetchedThisCall: 0,
      nextOffset: 440,
      truncated: false,
      apiNextCursor: null,
    });
    assert.deepEqual(got, { coverage: 'empty_page', done: false });
  });

  it('marks exhausted when the empty page is past total_count', () => {
    const got = classifyCallingListCoverage({
      countyEmpty: false,
      totalCount: 1030,
      startOffset: 1100,
      fetchedThisCall: 0,
      nextOffset: 1100,
      truncated: false,
      apiNextCursor: null,
    });
    assert.deepEqual(got, { coverage: 'exhausted', done: true });
  });

  it('uses no_coverage only when total is 0 (or first page empty with no total)', () => {
    assert.deepEqual(
      classifyCallingListCoverage({
        countyEmpty: false,
        totalCount: 0,
        startOffset: 0,
        fetchedThisCall: 0,
        nextOffset: 0,
        truncated: false,
        apiNextCursor: null,
      }),
      { coverage: 'no_coverage', done: true },
    );
  });

  it('keeps coverage ok and not done after 120 of 1030', () => {
    const got = classifyCallingListCoverage({
      countyEmpty: false,
      totalCount: 1030,
      startOffset: 80,
      fetchedThisCall: 40,
      nextOffset: 120,
      truncated: true,
      apiNextCursor: '4',
    });
    assert.deepEqual(got, { coverage: 'ok', done: false });
  });

  it('pageSkipForOffset is the same arithmetic the explicit offset path uses', () => {
    assert.deepEqual(pageSkipForOffset(120, 100), { cursor: '2', skip: 20 });
    assert.deepEqual(pageSkipForOffset(120, 40), { cursor: '4', skip: 0 });
    assert.deepEqual(pageSkipForOffset(0, 40), { cursor: null, skip: 0 });
  });

  it('walks Tampa page_size=40 three times then 100 from record 121', () => {
    let offset = 0;
    for (let i = 0; i < 3; i += 1) {
      const start = startCursorForGeo(
        {},
        offset === 0 ? undefined : { cursor: String(Math.floor(offset / 40) + 1), offset, fetched: offset, page_size: 40, total_count: 1030, done: false },
        40,
      );
      assert.equal(start.offset, offset);
      assert.equal(start.resumed, offset > 0);
      offset = start.offset + 40;
    }
    assert.equal(offset, 120);
    const fourth = startCursorForGeo(
      {},
      { offset, fetched: offset, page_size: 40, total_count: 1030, done: false, cursor: '4' },
      100,
    );
    assert.equal(fourth.offset, 120);
    assert.equal(fourth.cursor, '2');
    assert.equal(fourth.skip, 20);
    assert.equal(fourth.resumed, true);
  });

  it('resumes from the stored provider page when seen_ids exist (no mid-page skip)', () => {
    const start = startCursorForGeo(
      {},
      {
        cursor: '1',
        offset: 40,
        fetched: 40,
        page_size: 100,
        total_count: 160,
        done: false,
        seen_ids: Array.from({ length: 40 }, (_, i) => `id-${i}`),
      },
      100,
    );
    assert.equal(start.cursor, '1');
    assert.equal(start.skip, 0);
    assert.equal(start.resumed, true);
    assert.equal(start.offset, 40);
  });
});

describe('county empty predicate (estimator = puller)', () => {
  it('treats Harris-style 0 contractor rows as empty even when permit total is 1110', () => {
    assert.equal(
      isCountyQueryEmpty({ kind: 'county', itemsOnPage: 0, offset: 0, resumed: false }),
      true,
    );
    const classified = classifyProbeCoverage({
      county_query_empty: false,
      no_coverage: false,
      count_unreliable: false,
      items_on_probe: 0,
      total_count: 1110,
    });
    assert.equal(classified.coverage, 'county_query_empty');
    assert.equal(classified.estimated_pages, 0);
    assert.equal(classified.contractor_count, null);
  });

  it('keeps a city with real contractors as ok', () => {
    const classified = classifyProbeCoverage({
      county_query_empty: false,
      no_coverage: false,
      count_unreliable: false,
      items_on_probe: 1,
      total_count: 160,
    });
    assert.equal(classified.coverage, 'ok');
    assert.equal(classified.estimated_pages, 2);
    assert.equal(classified.contractor_count, 160);
  });

  it('does not flag a county that actually returned contractor rows', () => {
    assert.equal(
      isCountyQueryEmpty({ kind: 'county', itemsOnPage: 3, offset: 0, resumed: false }),
      false,
    );
  });
});

describe('dedupe before hydration', () => {
  it('splits already-seen ids without mutating the set', () => {
    const seen = new Set(['a', 'b']);
    const got = splitSeenContractors([row('a'), row('c'), row('b'), row('d')], seen);
    assert.deepEqual(
      got.fresh.map((c) => c.id),
      ['c', 'd'],
    );
    assert.equal(got.duplicates_skipped, 2);
    assert.equal(seen.has('c'), false);
  });

  it('reports contact_filter_yield as survivors / hydrations', () => {
    assert.equal(contactFilterYield(1, 40), 0.025);
    assert.equal(contactFilterYield(40, 0), null);
  });
});

function rawItem(id: string): Record<string, unknown> {
  return { id, name: id, business_name: id, city: 'Houston', state: 'TX', total_permits: 10 };
}

function houstonGeo(): ShovelsGeo {
  return { geo_id: 'city:houston:tx', name: 'Houston, TX', state: 'TX', kind: 'city' };
}

function pageFetch(universe: string[], pageSize: number, total: number) {
  return async (opts: { cursor?: string | null; size: number }) => {
    const page = opts.cursor && /^\d+$/.test(opts.cursor) ? Number(opts.cursor) : 1;
    const start = (page - 1) * pageSize;
    const items = universe.slice(start, start + opts.size).map(rawItem);
    const next = start + items.length < total ? String(page + 1) : null;
    return {
      items,
      next_cursor: next,
      total_count_raw: { value: total, relation: 'eq' as const },
      headers: { credits_request: 1, credits_limit: null, credits_remaining: null },
    };
  };
}

describe('collectCallingListWindow', () => {
  it('four 40-record windows over 160 ids yield 160 distinct and zero overlap', async () => {
    const universe = Array.from({ length: 160 }, (_, i) => `c${String(i).padStart(3, '0')}`);
    const seen = new Set<string>();
    const hydrated: string[] = [];
    const allSurvivors: string[] = [];
    let cursor: string | null = null;
    let skip = 0;
    let offset = 0;

    for (let w = 0; w < 4; w += 1) {
      const got = await collectCallingListWindow({
        geo: houstonGeo(),
        place: 'Houston',
        permit_from: '2025-01-01',
        permit_to: '2026-01-01',
        page_size: 100,
        max_records: 40,
        max_requests: 40,
        start_cursor: cursor,
        first_page_skip: seen.size > 0 ? 0 : skip,
        start_offset: offset,
        resumed: offset > 0,
        seen,
        filters: { has_phone: true },
        fetchPage: pageFetch(universe, 100, 160),
        hydrateProfiles: async (items, { max } = {}) => {
          const batch = items.slice(0, max ?? items.length);
          for (const c of batch) hydrated.push(c.id);
          return {
            items: batch.map((c) => ({ ...c, phone: '7135550100' })),
            attempted: batch.length,
            hydrated_ok: batch.length,
            hydrated_rate_limited: 0,
            hydrated_failed: 0,
            hydrated_skipped_synthetic_id: 0,
            requests: batch.length,
            http_attempts: batch.length,
            rate_limited: false,
          };
        },
      });
      const ids = got.survivors.map((c) => c.id);
      allSurvivors.push(...ids);
      assert.equal(new Set(ids).size, ids.length, `window ${w} had internal dups`);
      cursor = got.next_cursor;
      offset = got.seen_ids.length;
      skip = 0;
    }

    assert.equal(allSurvivors.length, 160);
    assert.equal(new Set(allSurvivors).size, 160);
    assert.equal(hydrated.length, 160);
    assert.equal(new Set(hydrated).size, 160);
  });

  it('does not re-hydrate ids already in seen (same window twice)', async () => {
    const universe = Array.from({ length: 80 }, (_, i) => `h${i}`);
    const seen = new Set<string>();
    const hydrateCounts = new Map<string, number>();
    const hydrate = async (items: ShovelsApiContractor[], { max } = { max: items.length }) => {
      const batch = items.slice(0, max ?? items.length);
      for (const c of batch) hydrateCounts.set(c.id, (hydrateCounts.get(c.id) ?? 0) + 1);
      return {
        items: batch.map((c) => ({ ...c, phone: '7135550100' })),
        attempted: batch.length,
        hydrated_ok: batch.length,
        hydrated_rate_limited: 0,
        hydrated_failed: 0,
        hydrated_skipped_synthetic_id: 0,
        requests: batch.length,
        http_attempts: batch.length,
        rate_limited: false,
      };
    };

    const first = await collectCallingListWindow({
      geo: houstonGeo(),
      place: 'Houston',
      permit_from: '2025-01-01',
      permit_to: '2026-01-01',
      page_size: 100,
      max_records: 40,
      max_requests: 40,
      start_cursor: null,
      first_page_skip: 0,
      start_offset: 0,
      resumed: false,
      seen,
      filters: { has_phone: true },
      fetchPage: pageFetch(universe, 100, 80),
      hydrateProfiles: hydrate,
    });
    assert.equal(first.survivors.length, 40);
    assert.equal(first.hydration.requests, 40);

    const second = await collectCallingListWindow({
      geo: houstonGeo(),
      place: 'Houston',
      permit_from: '2025-01-01',
      permit_to: '2026-01-01',
      page_size: 100,
      max_records: 40,
      max_requests: 40,
      start_cursor: null,
      first_page_skip: 0,
      start_offset: 0,
      resumed: false,
      seen,
      filters: { has_phone: true },
      fetchPage: pageFetch(universe, 100, 80),
      hydrateProfiles: hydrate,
    });
    assert.equal(second.duplicates_skipped >= 40, true);
    assert.equal(second.hydration.requests, 40);
    for (const [id, n] of hydrateCounts) {
      assert.equal(n, 1, `${id} hydrated ${n} times`);
    }
    const overlap = second.survivors.filter((c) => first.survivors.some((s) => s.id === c.id));
    assert.equal(overlap.length, 0);
  });

  it('keeps fetching until max_records survivors or max_requests, and reports yield', async () => {
    const universe = Array.from({ length: 200 }, (_, i) => `lj${i}`);
    const seen = new Set<string>();
    const got = await collectCallingListWindow({
      geo: { geo_id: 'city:lake-jackson:tx', name: 'Lake Jackson, TX', state: 'TX', kind: 'city' },
      place: 'Lake_Jackson',
      permit_from: '2025-01-01',
      permit_to: '2026-01-01',
      page_size: 40,
      max_records: 5,
      max_requests: 40,
      start_cursor: null,
      first_page_skip: 0,
      start_offset: 0,
      resumed: false,
      seen,
      filters: { has_phone: true },
      fetchPage: pageFetch(universe, 40, 200),
      hydrateProfiles: async (items, { max } = {}) => {
        const batch = items.slice(0, max ?? items.length);
        return {
          items: batch.map((c, i) => ({
            ...c,
            // ~2.5% yield: phone on every 40th contractor in the universe (lj0, lj40, ...)
            phone: Number(c.id.slice(2)) % 40 === 0 ? '9795550100' : null,
          })),
          attempted: batch.length,
          hydrated_ok: batch.length,
          hydrated_rate_limited: 0,
          hydrated_failed: 0,
          hydrated_skipped_synthetic_id: 0,
          requests: batch.length,
          http_attempts: batch.length,
          rate_limited: false,
        };
      },
    });
    assert.equal(got.survivors.length, 1);
    assert.equal(got.hydration.requests, 40);
    assert.equal(contactFilterYield(got.survivors.length, got.hydration.requests), 0.025);
  });

  it('flags a county first page with 0 contractor rows as county empty', async () => {
    const got = await collectCallingListWindow({
      geo: { geo_id: 'county:harris:tx', name: 'Harris County, TX', state: 'TX', kind: 'county' },
      place: 'Harris_County',
      permit_from: '2025-01-01',
      permit_to: '2026-01-01',
      page_size: 100,
      max_records: 40,
      max_requests: 40,
      start_cursor: null,
      first_page_skip: 0,
      start_offset: 0,
      resumed: false,
      seen: new Set(),
      filters: {},
      fetchPage: async () => ({
        items: [],
        next_cursor: '2',
        total_count_raw: { value: 1110, relation: 'eq' },
        headers: { credits_request: 1, credits_limit: null, credits_remaining: null },
      }),
    });
    assert.equal(got.county_empty, true);
    assert.equal(got.survivors.length, 0);
  });
});

