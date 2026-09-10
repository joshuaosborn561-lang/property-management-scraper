import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ShovelsApiContractor } from '../lib/shovels.js';
import {
  applyContactFilters,
  applyStructuralFilters,
  classifyCallingListCoverage,
  pageSkipForOffset,
  recordOffsetFromJob,
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
});
