import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { geoNameMatches, parseTotalCount, pickGeo, resolveShovelsGeo } from '../lib/shovels.js';
import { parseGeoToken, resolveGeoTargets, tokenizeGeos } from './shovelsGeoTargets.js';

describe('parseTotalCount', () => {
  it('reads Shovels {value,relation} shape (not items.length)', () => {
    assert.deepEqual(parseTotalCount({ value: 4279, relation: 'eq' }), {
      value: 4279,
      relation: 'eq',
    });
    // Bare Number({value}) was NaN → old code fell through to size=1
    assert.equal(Number({ value: 4279 }), Number.NaN);
  });

  it('accepts bare numbers', () => {
    assert.equal(parseTotalCount(12).value, 12);
  });
});

describe('pickGeo / geoNameMatches', () => {
  it('does not force TX when other states are present', () => {
    const geo = pickGeo(
      [
        { geo_id: 'tx1', name: 'Miami, TX', state: 'TX' },
        { geo_id: 'fl1', name: 'Miami, FL', state: 'FL' },
      ],
      'city',
      'Miami',
      'FL',
    );
    assert.equal(geo?.geo_id, 'fl1');
    assert.equal(geo?.state, 'FL');
  });

  it('accepts Shovels county names that omit County (Denton, TX)', () => {
    assert.equal(geoNameMatches('Denton, TX', 'county', 'Denton', 'TX'), true);
    assert.equal(geoNameMatches('Denton, TX', 'county', 'Denton County', 'TX'), true);
    assert.equal(geoNameMatches('Orleans, LA', 'county', 'Orleans Parish', 'LA'), true);
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), 'data/shovels_fixtures/counties_search_denton.json'), 'utf8'),
    ) as { items: Array<{ geo_id?: string; name?: string; state?: string }> };
    const geo = pickGeo(fixture.items, 'county', 'Denton', 'TX');
    assert.equal(geo?.geo_id, '63FDGkZW8pk');
    assert.equal(geo?.kind, 'county');
  });

  it('county pick rejects city-inside-other-county hits', () => {
    const geo = pickGeo(
      [
        { geo_id: 'bad', name: 'Hunt, Kerr, TX', state: 'TX' },
        { geo_id: 'good', name: 'Hunt County, TX', state: 'TX' },
      ],
      'county',
      'Hunt',
      'TX',
    );
    assert.equal(geo?.geo_id, 'good');
    assert.equal(geo?.kind, 'county');
  });

  it('returns null when only mismatched city hits exist for a county request', () => {
    const geo = pickGeo(
      [{ geo_id: 'bad', name: 'Texhoma, Sherman, TX', state: 'TX' }],
      'county',
      'Sherman',
      'TX',
    );
    assert.equal(geo, null);
  });

  it('resolveShovelsGeo synthesizes PermitStack county ids without a live geo index', async () => {
    const geo = await resolveShovelsGeo({
      kind: 'county',
      q: 'Denton',
      state: 'TX',
    });
    assert.equal(geo.geo_id, 'county:denton:tx');
    assert.equal(geo.kind, 'county');
    assert.equal(geo.state, 'TX');
    assert.match(geo.name, /Denton County/i);
  });

  it('resolveShovelsGeo uses recorded Denton county fixture (no live API)', async () => {
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), 'data/shovels_fixtures/counties_search_denton.json'), 'utf8'),
    ) as { items: Array<{ geo_id?: string; name?: string; state?: string }> };
    const geo = await resolveShovelsGeo({
      kind: 'county',
      q: 'Denton',
      state: 'TX',
      searchItems: fixture.items,
    });
    assert.equal(geo.geo_id, '63FDGkZW8pk');
    assert.equal(geo.kind, 'county');
    assert.equal(geo.state, 'TX');
  });

  it('county refusal hint does not tell the caller to pass geo_level=county', async () => {
    await assert.rejects(
      () =>
        resolveShovelsGeo({
          kind: 'county',
          q: 'Sherman',
          state: 'TX',
          searchItems: [{ geo_id: 'bad', name: 'Texhoma, Sherman, TX', state: 'TX' }],
        }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /already county/i);
        assert.doesNotMatch(msg, /geo_level=county/);
        return true;
      },
    );
  });

  it('city pick rejects Collin → Anna, Collin, TX', () => {
    assert.equal(geoNameMatches('Anna, Collin, TX', 'city', 'Collin', 'TX'), false);
    const geo = pickGeo(
      [{ geo_id: 'bad', name: 'Anna, Collin, TX', state: 'TX' }],
      'city',
      'Collin',
      'TX',
    );
    assert.equal(geo, null);
  });
});

describe('tokenizeGeos / parseGeoToken', () => {
  it('rejoins County; TX semicolon slots (no phantom TX → Azle)', () => {
    const tokens = tokenizeGeos(
      'Denton County; TX; Collin County; TX; Ellis County; TX; Johnson County; TX',
    );
    assert.deepEqual(tokens, [
      'Denton County, TX',
      'Collin County, TX',
      'Ellis County, TX',
      'Johnson County, TX',
    ]);
    const targets = resolveGeoTargets({
      geos: 'Denton County; TX; Collin County; TX; Hunt County; TX',
    });
    assert.equal(targets.length, 3);
    assert.ok(targets.every((t) => t.kind === 'county' && t.state === 'TX'));
    assert.ok(!targets.some((t) => t.kind === 'state' || t.q === 'TX'));
  });

  it('keeps Denton County, TX intact', () => {
    const tokens = tokenizeGeos('Denton County, TX; Collin County, TX');
    assert.deepEqual(tokens, ['Denton County, TX', 'Collin County, TX']);
    const denton = parseGeoToken('Denton County, TX');
    assert.equal(denton.kind, 'county');
    assert.equal(denton.q, 'Denton');
    assert.equal(denton.state, 'TX');
  });

  it('accepts ZIP lists', () => {
    const tokens = tokenizeGeos('75001, 75035, 75201');
    assert.deepEqual(tokens, ['75001', '75035', '75201']);
    assert.equal(parseGeoToken('75001').kind, 'zip');
  });

  it('maps DFW-ring bare names to county aliases', () => {
    const hunt = parseGeoToken('Hunt');
    assert.equal(hunt.kind, 'county');
    assert.equal(hunt.q, 'Hunt');
    assert.equal(hunt.state, 'TX');
    const collin = resolveGeoTargets({ geos: 'Collin, Ellis, Johnson' });
    assert.ok(collin.every((t) => t.kind === 'county'));
  });

  it('honors geo_level=county', () => {
    const rows = resolveGeoTargets({ geos: 'Foo, Bar', geo_level: 'county', state: 'TX' });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((t) => t.kind === 'county' && t.state === 'TX'));
  });

  it('expands east_coast and west_coast aliases', () => {
    const east = resolveGeoTargets({ geos: 'east_coast' });
    assert.ok(east.some((t) => t.place === 'Miami' && t.state === 'FL'));
    const west = resolveGeoTargets({ geos: 'west_coast' });
    assert.ok(west.some((t) => t.place === 'Los_Angeles' && t.state === 'CA'));
  });
});
