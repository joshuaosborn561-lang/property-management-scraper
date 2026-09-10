import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { clearAppSetting, setAppSetting } from './appSettings.js';
import {
  FloridaSunbizError,
  expandOfficerTitle,
  floridaSunbizKeyStatus,
  getSunbizEntity,
  isRetryableFloridaOfficerMatch,
  looksLikeCloudflareChallenge,
  normalizeSunbizPersonName,
  parseDetailHtml,
  parseSearchResultsHtml,
  pickSunbizOwnerOfficer,
  prepareFloridaSunbizRun,
  rankSunbizHits,
  resetFloridaSunbizSource,
  searchSunbizEntities,
  setFloridaSunbizFetch,
} from './floridaSunbiz.js';

const SEARCH_HTML = `
<table>
<tr><th>Corporate Name</th><th>Document Number</th><th>Status</th></tr>
<tr>
  <td><a href="/Inquiry/CorporationSearch/SearchResultDetail?inquirytype=EntityName&amp;directionType=Initial&amp;searchNameOrder=TAMPAROOFINGCOMPANY+302224&amp;aggregateId=domp-302224-aaaa-bbbb-cccc-dddddddddddd&amp;searchTerm=TAMPA+ROOFING&amp;listNameOrder=TAMPAROOFINGCOMPANY+302224">TAMPA ROOFING COMPANY</a></td>
  <td class="medium-width">302224</td>
  <td class="small-width">Active</td>
</tr>
<tr>
  <td><a href="/Inquiry/CorporationSearch/SearchResultDetail?inquirytype=EntityName&amp;directionType=Initial&amp;searchNameOrder=TAMPAROOFINGBROKERS+L24000290322&amp;aggregateId=flal-l24000290322-eeee-ffff-1111-222222222222&amp;searchTerm=TAMPA+ROOFING&amp;listNameOrder=TAMPAROOFINGBROKERS+L24000290322">TAMPA ROOFING BROKERS LLC</a></td>
  <td class="medium-width">L24000290322</td>
  <td class="small-width">INACT/UA</td>
</tr>
<tr>
  <td><a href="/Inquiry/CorporationSearch/SearchResultDetail?inquirytype=EntityName&amp;aggregateId=trade-t23000000653-zzzz&amp;searchTerm=TAMPA+ROOFING">TAMPA ROTATED MARK</a></td>
  <td class="medium-width">T23000000653</td>
  <td class="small-width">Active</td>
</tr>
</table>
`;

const DETAIL_HTML = `
<div id="mainContent">
  <div class="detailSection">
    <p class="corporationName">Florida Profit Corporation</p>
    <p class="corporationName">TAMPA ROOFING COMPANY</p>
  </div>
  <div>
    <span class="label">Document Number</span>
    <span>302224</span>
    <span class="label">FEI/EIN Number</span>
    <span>59-1234567</span>
    <span class="label">Status</span>
    <span>ACTIVE</span>
  </div>
  <div class="detailSection">
    <span class="label">Registered Agent Name & Address</span>
    <div>CORPORATION SERVICE COMPANY</div>
    <div>1201 HAYS STREET<br>TALLAHASSEE, FL 32301</div>
  </div>
  <div class="detailSection">
    <span class="label">Officer/Director Detail</span>
    <span class="label">Name & Address</span>
    Title&nbsp;P
    <span class="width66">DOE, JOHN A</span><br>
    123 MAIN ST<br>
    TAMPA, FL 33602
    Title&nbsp;VP
    <span class="width66">SMITH, JANE</span><br>
    456 OAK AVE<br>
    TAMPA, FL 33606
  </div>
  <div class="detailSection">
    <span class="label">Annual Reports</span>
  </div>
</div>
`;

afterEach(async () => {
  setFloridaSunbizFetch(null);
  resetFloridaSunbizSource();
  await clearAppSetting({ key: 'florida_sos_api_key', set_by: 'test' });
});

describe('normalizeSunbizPersonName', () => {
  it('turns LAST, FIRST MIDDLE into FIRST MIDDLE LAST', () => {
    assert.equal(normalizeSunbizPersonName('DOE, JOHN A'), 'JOHN A DOE');
  });

  it('leaves western-order names alone', () => {
    assert.equal(normalizeSunbizPersonName('John Doe'), 'John Doe');
  });
});

describe('expandOfficerTitle', () => {
  it('expands Sunbiz title abbreviations', () => {
    assert.equal(expandOfficerTitle('P'), 'President');
    assert.equal(expandOfficerTitle('MGR'), 'Manager');
    assert.equal(expandOfficerTitle('Vice President'), 'Vice President');
  });
});

describe('parseSearchResultsHtml', () => {
  it('parses name, document number, status, and skips trademarks', () => {
    const hits = parseSearchResultsHtml(SEARCH_HTML);
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.name, 'TAMPA ROOFING COMPANY');
    assert.equal(hits[0]?.document_number, '302224');
    assert.equal(hits[0]?.status, 'Active');
    assert.equal(hits[0]?.aggregate_id, 'domp-302224-aaaa-bbbb-cccc-dddddddddddd');
    assert.match(hits[0]?.detail_url || '', /SearchResultDetail/);
    assert.equal(hits[1]?.document_number, 'L24000290322');
  });
});

describe('parseDetailHtml', () => {
  it('extracts officers in western name order and flags the registered agent', () => {
    const entity = parseDetailHtml(DETAIL_HTML);
    assert.ok(entity);
    assert.equal(entity?.name, 'TAMPA ROOFING COMPANY');
    assert.equal(entity?.document_number, '302224');
    assert.equal(entity?.status, 'ACTIVE');
    assert.equal(entity?.registered_agent, 'CORPORATION SERVICE COMPANY');
    assert.equal(entity?.officers.length, 2);
    assert.equal(entity?.officers[0]?.name, 'JOHN A DOE');
    assert.equal(entity?.officers[0]?.title, 'President');
    assert.equal(entity?.officers[0]?.city, 'TAMPA');
    assert.equal(entity?.officers[0]?.state, 'FL');
    assert.equal(entity?.officers[0]?.zip, '33602');
    assert.equal(entity?.officers[1]?.name, 'JANE SMITH');
    assert.equal(entity?.officers[0]?.is_registered_agent, false);
  });
});

describe('rankSunbizHits', () => {
  it('prefers an Active exact match over an inactive neighbour', () => {
    const ranked = rankSunbizHits('TAMPA ROOFING COMPANY', parseSearchResultsHtml(SEARCH_HTML));
    assert.equal(ranked[0]?.document_number, '302224');
    assert.equal(ranked[0]?.status, 'Active');
  });
});

describe('pickSunbizOwnerOfficer', () => {
  it('matches a calling-list contact to the Sunbiz officer', () => {
    const entity = parseDetailHtml(DETAIL_HTML);
    assert.ok(entity);
    const picked = pickSunbizOwnerOfficer('John Doe', entity!);
    assert.equal(picked.match, 'match');
    assert.equal(picked.officer?.name, 'JOHN A DOE');
  });
});

describe('looksLikeCloudflareChallenge', () => {
  it('detects a 403 challenge page', () => {
    assert.equal(looksLikeCloudflareChallenge(403, 'Just a moment'), true);
    assert.equal(looksLikeCloudflareChallenge(200, DETAIL_HTML), false);
  });
});

describe('searchSunbizEntities fetch', { concurrency: false }, () => {
  it('parses live HTML when Sunbiz returns 200', async () => {
    setFloridaSunbizFetch(async () => new Response(SEARCH_HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    const hits = await searchSunbizEntities('TAMPA ROOFING COMPANY');
    assert.equal(hits[0]?.document_number, '302224');
  });

  it('fails loudly when Cloudflare blocks and no API key is set', async () => {
    setFloridaSunbizFetch(
      async () =>
        new Response('Performing security verification', {
          status: 403,
          headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
        }),
    );
    await assert.rejects(
      () => searchSunbizEntities('TAMPA ROOFING COMPANY'),
      (err: unknown) => {
        assert.ok(err instanceof FloridaSunbizError);
        assert.equal(err.blocked, true);
        assert.match(err.message, /florida_sos_api_key/i);
        return true;
      },
    );
  });

  it('falls back to Sunbiz Daily JSON when HTML is blocked and a key is set', async () => {
    await setAppSetting({
      key: 'florida_sos_api_key',
      api_key: 'test-sunbiz-daily-key',
      persist: false,
      set_by: 'test',
    });
    setFloridaSunbizFetch(async (input) => {
      const url = String(input);
      if (url.includes('search.sunbiz.org')) {
        return new Response('Just a moment', { status: 403 });
      }
      if (url.includes('P97000071529') && url.includes('sunbizdaily.com')) {
        return new Response(
          JSON.stringify({
            corporation_number: 'P97000071529',
            corporation_name: 'WALT DISNEY PARKS AND RESORTS U.S., INC.',
            status: 'A',
            officers: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('sunbizdaily.com')) {
        return new Response(
          JSON.stringify({
            filings: [
              {
                corporation_number: 'P97000071529',
                corporation_name: 'WALT DISNEY PARKS AND RESORTS U.S., INC.',
                status: 'A',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('nope', { status: 404 });
    });
    const hits = await searchSunbizEntities('WALT DISNEY PARKS AND RESORTS U.S., INC.');
    assert.equal(hits[0]?.document_number, 'P97000071529');
    const entity = await getSunbizEntity({
      name: 'WALT DISNEY PARKS AND RESORTS U.S., INC.',
      document_number: 'P97000071529',
      status: 'A',
      detail_url: 'https://www.sunbizdaily.com/api/v2/filings/P97000071529/',
      aggregate_id: null,
      search_name_order: null,
    });
    assert.equal(entity?.source, 'sunbizdaily');
    assert.equal(entity?.document_number, 'P97000071529');
  });

  it('sends an sb_ key to Sunbiz Daily as X-API-Key, not to sunbizdata.com', async () => {
    await setAppSetting({
      key: 'florida_sos_api_key',
      api_key: 'sb_official_daily_test_key',
      persist: false,
      set_by: 'test',
    });
    const hosts: string[] = [];
    const headersSeen: string[] = [];
    setFloridaSunbizFetch(async (input, init) => {
      const url = String(input);
      hosts.push(url);
      const headers = new Headers(init?.headers);
      if (headers.get('X-API-Key')) headersSeen.push(`X-API-Key:${headers.get('X-API-Key')}`);
      if (headers.get('x-api-key') && !headers.get('X-API-Key')) {
        headersSeen.push(`x-api-key:${headers.get('x-api-key')}`);
      }
      if (url.includes('search.sunbiz.org')) {
        return new Response('Just a moment', { status: 403 });
      }
      if (url.includes('sunbizdata.com')) {
        return new Response(JSON.stringify({ error: 'wrong host' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('sunbizdaily.com') && url.includes('P97000071529') && /filings\/P97000071529/.test(url)) {
        return new Response(
          JSON.stringify({
            corporation_number: 'P97000071529',
            corporation_name: 'WALT DISNEY PARKS AND RESORTS U.S., INC.',
            status: 'A',
            officers: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('sunbizdaily.com')) {
        return new Response(
          JSON.stringify({
            filings: [
              {
                corporation_number: 'P97000071529',
                corporation_name: 'WALT DISNEY PARKS AND RESORTS U.S., INC.',
                status: 'A',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('nope', { status: 404 });
    });
    const hits = await searchSunbizEntities('WALT DISNEY PARKS AND RESORTS U.S., INC.');
    assert.equal(hits[0]?.document_number, 'P97000071529');
    assert.ok(hosts.some((u) => u.includes('sunbizdaily.com')));
    assert.equal(hosts.some((u) => u.includes('sunbizdata.com')), false);
    assert.ok(headersSeen.some((h) => h.startsWith('X-API-Key:sb_official_daily_test_key')));
  });

  it('falls back to sunbizdata.com only after Sunbiz Daily rejects the key', async () => {
    await setAppSetting({
      key: 'florida_sos_api_key',
      api_key: 'sb_data_only_test_key',
      persist: false,
      set_by: 'test',
    });
    const hosts: string[] = [];
    setFloridaSunbizFetch(async (input) => {
      const url = String(input);
      hosts.push(url);
      if (url.includes('search.sunbiz.org')) {
        return new Response('Just a moment', { status: 403 });
      }
      if (url.includes('sunbizdaily.com')) {
        return new Response(JSON.stringify({ error: { code: 401, message: 'invalid key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('sunbizdata.com')) {
        return new Response(
          JSON.stringify({
            results: [
              {
                documentNumber: 'P97000071529',
                corporationName: 'WALT DISNEY PARKS AND RESORTS U.S., INC.',
                status: 'A',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('nope', { status: 404 });
    });
    const hits = await searchSunbizEntities('WALT DISNEY PARKS AND RESORTS U.S., INC.');
    assert.equal(hits[0]?.document_number, 'P97000071529');
    assert.ok(hosts.some((u) => u.includes('sunbizdaily.com')));
    assert.ok(hosts.some((u) => u.includes('sunbizdata.com')));
  });

  it('uses public HTML first even when a keyed API would 401', async () => {
    await setAppSetting({
      key: 'florida_sos_api_key',
      api_key: 'sb_bad_test_key_xx',
      persist: false,
      set_by: 'test',
    });
    let apiCalls = 0;
    setFloridaSunbizFetch(async (input) => {
      const url = String(input);
      if (url.includes('sunbizdata.com') || url.includes('sunbizdaily.com')) {
        apiCalls += 1;
        return new Response(JSON.stringify({ error: { code: 401 } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(SEARCH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const hits = await searchSunbizEntities('TAMPA ROOFING COMPANY');
    assert.equal(hits[0]?.document_number, '302224');
    assert.equal(apiCalls, 0);
  });

  it('falls back to public HTML when the keyed API returns 401', async () => {
    await setAppSetting({
      key: 'florida_sos_api_key',
      api_key: 'sb_bad_test_key_xx',
      persist: false,
      set_by: 'test',
    });
    let htmlCalls = 0;
    setFloridaSunbizFetch(async (input) => {
      const url = String(input);
      if (url.includes('search.sunbiz.org')) {
        htmlCalls += 1;
        if (htmlCalls === 1) return new Response('Just a moment', { status: 403 });
        return new Response(SEARCH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response(JSON.stringify({ error: { code: 401, message: 'invalid key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    const hits = await searchSunbizEntities('TAMPA ROOFING COMPANY');
    assert.equal(hits[0]?.document_number, '302224');
    assert.equal(floridaSunbizKeyStatus(), 'rejected_falling_back_to_html');
    assert.ok(htmlCalls >= 2);
  });

  it('does not stringify keyed 401 bodies as [object Object]', async () => {
    await setAppSetting({
      key: 'florida_sos_api_key',
      api_key: 'sb_bad_test_key_xx',
      persist: false,
      set_by: 'test',
    });
    setFloridaSunbizFetch(async (input) => {
      const url = String(input);
      if (url.includes('search.sunbiz.org')) {
        return new Response('Just a moment', { status: 403 });
      }
      return new Response(JSON.stringify({ error: { code: 401, message: 'invalid key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    await assert.rejects(
      () => searchSunbizEntities('TAMPA ROOFING COMPANY'),
      (err: unknown) => {
        assert.ok(err instanceof FloridaSunbizError);
        assert.equal(err.message.includes('[object Object]'), false);
        assert.match(err.message, /invalid key|401/);
        return true;
      },
    );
  });

  it('prepareFloridaSunbizRun marks a 401 key as rejected before any row work', async () => {
    await setAppSetting({
      key: 'florida_sos_api_key',
      api_key: 'sb_bad_test_key_xx',
      persist: false,
      set_by: 'test',
    });
    setFloridaSunbizFetch(async () => {
      return new Response(JSON.stringify({ error: { code: 401, message: 'invalid key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    const prepared = await prepareFloridaSunbizRun();
    assert.equal(prepared.api_usable, false);
    assert.equal(prepared.key_status, 'rejected_falling_back_to_html');
  });
});

describe('isRetryableFloridaOfficerMatch', () => {
  it('retries error and unavailable so a bad key cannot poison the queue', () => {
    assert.equal(isRetryableFloridaOfficerMatch(null), true);
    assert.equal(isRetryableFloridaOfficerMatch('error'), true);
    assert.equal(isRetryableFloridaOfficerMatch('unavailable'), true);
    assert.equal(isRetryableFloridaOfficerMatch('none'), false);
    assert.equal(isRetryableFloridaOfficerMatch('match'), false);
  });
});
