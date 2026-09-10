import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ShovelsApiContractor } from '../lib/shovels.js';
import {
  applyContactFilters,
  applyStructuralFilters,
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
      { cursor: '2', done: false },
      100,
    );
    assert.deepEqual(start, { cursor: '4', skip: 0, resumed: false });
  });

  it('turns offset into a page + skip so a second window is not page 1', () => {
    const start = startCursorForGeo({ offset: 200 }, undefined, 100);
    assert.deepEqual(start, { cursor: '3', skip: 0, resumed: false });
  });

  it('resumes the stored cursor when no explicit pager is passed', () => {
    const start = startCursorForGeo({}, { cursor: '3', done: false }, 100);
    assert.deepEqual(start, { cursor: '3', skip: 0, resumed: true });
  });

  it('does not resume a completed job', () => {
    const start = startCursorForGeo({}, { cursor: '9', done: true }, 100);
    assert.deepEqual(start, { cursor: null, skip: 0, resumed: false });
  });
});
