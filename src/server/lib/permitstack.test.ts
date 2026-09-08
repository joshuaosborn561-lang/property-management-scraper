import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cityQueryForGeo,
  mapPermitstackContractor,
  parseGeoId,
  synthesizeGeoId,
} from './permitstack.js';
import type { ShovelsGeo } from './shovels.js';

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

  it('maps county geos to city + jurisdiction for PermitStack', () => {
    const geo: ShovelsGeo = {
      geo_id: 'county:denton:tx',
      name: 'Denton County, TX',
      state: 'TX',
      kind: 'county',
    };
    assert.deepEqual(cityQueryForGeo(geo), {
      city: 'Denton',
      state: 'TX',
      jurisdiction: 'Denton County',
    });
  });
});

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
