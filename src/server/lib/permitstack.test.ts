import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cityQueryForGeo,
  hydratePermitstackProfiles,
  mapPermitstackContractor,
  parseGeoId,
  PermitstackHttpError,
  PermitstackRateLimiter,
  synthesizeGeoId,
  uniquePermitContractors,
} from './permitstack.js';
import type { ShovelsApiContractor, ShovelsGeo } from './shovels.js';

describe('PermitStack geo ids', () => {
  it('synthesizes city / county / state / zip', () => {
    assert.equal(synthesizeGeoId('city', 'Dallas', 'TX'), 'city:dallas:tx');
    assert.equal(synthesizeGeoId('county', 'Denton', 'TX'), 'county:denton:tx');
    assert.equal(synthesizeGeoId('state', 'TX'), 'state:TX');
    assert.equal(synthesizeGeoId('zip', '75001-1234'), 'zip:75001');
  });

  it('parses synthesized ids back to search params', () => {
    assert.deepEqual(parseGeoId('county:denton:tx'), {
      kind: 'county',
      city: 'Denton',
      state: 'TX',
    });
    assert.deepEqual(parseGeoId('city:san-antonio:tx'), {
      kind: 'city',
      city: 'San Antonio',
      state: 'TX',
    });
    assert.deepEqual(parseGeoId('zip:75001'), { kind: 'zip', zip: '75001' });
    assert.deepEqual(parseGeoId('state:CA'), { kind: 'state', state: 'CA' });
  });

  it('maps county geos to jurisdiction only — never city=core', () => {
    const geo: ShovelsGeo = {
      geo_id: 'county:hillsborough:fl',
      name: 'Hillsborough County, FL',
      state: 'FL',
      kind: 'county',
    };
    assert.deepEqual(cityQueryForGeo(geo), {
      state: 'FL',
      jurisdiction: 'Hillsborough County',
    });
    assert.equal('city' in cityQueryForGeo(geo), false);
  });
});

function contractor(id: string, extra: Partial<ShovelsApiContractor> = {}): ShovelsApiContractor {
  return {
    id,
    name: id,
    business_name: id,
    dba: null,
    phone: null,
    primary_phone: null,
    email: null,
    primary_email: null,
    website: null,
    linkedin_url: null,
    employee_count: null,
    address_street: null,
    address_city: 'Tampa',
    address_state: 'FL',
    address_zip: null,
    places: ['Tampa'],
    permit_count: 5,
    total_job_value: null,
    primary_industry: null,
    business_type: null,
    ...extra,
  };
}

describe('mapPermitstackContractor', () => {
  it('reads PermitStack profile fields and Shovels-shaped fixtures', () => {
    const live = mapPermitstackContractor(
      {
        id: '90dc4456-abc5-4273-aacd-f1e53c4297fd',
        name: 'MCCARTHY BUILDING COMPANIES',
        city: 'Dallas',
        state: 'TX',
        phone: '2145550100',
        email: 'jobs@example.com',
        address: '123 Main St',
        zip_code: '75201',
        total_permits: 857,
        specialties: ['new_construction', 'hvac'],
        is_business: true,
      },
      'Dallas',
    );
    assert.equal(live.id, '90dc4456-abc5-4273-aacd-f1e53c4297fd');
    assert.equal(live.phone, '2145550100');
    assert.equal(live.address_city, 'Dallas');
    assert.equal(live.permit_count, 857);
    assert.equal(live.primary_industry, 'new_construction|hvac');

    const fixture = mapPermitstackContractor(
      {
        id: 'a',
        name: 'A',
        business_name: 'A LLC',
        address: { city: 'Denton', state: 'TX' },
      },
      'Denton_County',
    );
    assert.equal(fixture.address_city, 'Denton');
    assert.equal(fixture.business_name, 'A LLC');
  });
});

describe('uniquePermitContractors', () => {
  it('prefers contractor_id so ZIP/county rows can hydrate', () => {
    const rows = uniquePermitContractors([
      { contractor_name: 'Acme', contractor_id: 'uuid-1', address_city: 'Tampa' },
      { contractor_name: 'No Id LLC', address_city: 'Tampa' },
    ]);
    assert.equal(rows[0]?.id, 'uuid-1');
    assert.equal(String(rows[1]?.id).startsWith('name:'), true);
  });
});

describe('hydratePermitstackProfiles', () => {
  it('retries 429s and does not count a retry as a new contractor', async () => {
    let calls = 0;
    const get = async (path: string) => {
      calls += 1;
      if (calls < 3) {
        throw new PermitstackHttpError(429, path, 'Per-minute rate limit exceeded: 60 requests/min on the developer plan', 0);
      }
      return {
        body: { id: 'a', phone: '8135550100', name: 'A' },
        headers: { credits_request: 1, credits_limit: null, credits_remaining: null },
        status: 200,
      };
    };
    const result = await hydratePermitstackProfiles([contractor('a')], {
      get,
      sleep: async () => undefined,
    });
    assert.equal(calls, 3);
    assert.equal(result.requests, 1);
    assert.equal(result.hydrated_ok, 1);
    assert.equal(result.hydrated_rate_limited, 0);
    assert.equal(result.attempted, 1);
    assert.equal(result.items[0]?.phone, '8135550100');
  });

  it('keeps 403/404 rows and counts them failed, not rate-limited', async () => {
    const get = async (path: string) => {
      throw new PermitstackHttpError(403, path, 'contact fields require Developer plan');
    };
    const result = await hydratePermitstackProfiles([contractor('a')], {
      get,
      sleep: async () => undefined,
    });
    assert.equal(result.requests, 0);
    assert.equal(result.hydrated_failed, 1);
    assert.equal(result.hydrated_rate_limited, 0);
    assert.equal(result.rate_limited, false);
    assert.equal(result.items[0]?.phone, null);
  });

  it('skips synthetic name: ids and reports the skip counter', async () => {
    const get = async () => {
      throw new Error('should not be called');
    };
    const result = await hydratePermitstackProfiles([contractor('name:acme')], {
      get,
      sleep: async () => undefined,
    });
    assert.equal(result.attempted, 0);
    assert.equal(result.hydrated_skipped_synthetic_id, 1);
    assert.equal(result.requests, 0);
  });

  it('splits exhausted 429s from later rows so counters add up', async () => {
    const get = async (path: string) => {
      throw new PermitstackHttpError(429, path, '60 requests/min', 0);
    };
    const items = [contractor('a'), contractor('b'), contractor('c')];
    const result = await hydratePermitstackProfiles(items, {
      get,
      sleep: async () => undefined,
    });
    assert.equal(result.attempted, 3);
    assert.equal(
      result.hydrated_ok + result.hydrated_rate_limited + result.hydrated_failed,
      result.attempted,
    );
    assert.equal(result.hydrated_rate_limited, 3);
    assert.equal(result.rate_limited, true);
    assert.equal(result.hydrated_ok, 0);
  });
});

describe('PermitstackRateLimiter', () => {
  it('paces under maxPerMinute without firing a 61st call in the window', async () => {
    let now = 1_000_000;
    const waits: number[] = [];
    const limiter = new PermitstackRateLimiter(2, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    assert.ok(waits.length >= 1, 'third acquire must wait');
  });
});
