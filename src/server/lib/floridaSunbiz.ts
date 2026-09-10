import { getSetting, loadAppSettings } from './appSettings.js';
import { formatApiError, inspectFloridaSosKey, isSunbizdataKey } from './floridaSosKey.js';
import {
  isRegisteredAgentName,
  namesLooselyMatch,
  pickOwnerOfficer,
  rankFranchiseHits,
  type ComptrollerEntity,
  type ComptrollerOfficer,
} from './texasComptroller.js';

const SUNBIZ_ORIGIN = 'https://search.sunbiz.org';
const SUNBIZ_SEARCH = `${SUNBIZ_ORIGIN}/Inquiry/CorporationSearch/SearchResults`;
const SUNBIZDATA_BASE = 'https://api.sunbizdata.com/api/v1';
const SUNBIZDAILY_BASE = 'https://www.sunbizdaily.com/api/v2';

const SEARCH_TERM_MAX = 45;
const HTML_GAP_MS = 400;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SunbizOfficer extends ComptrollerOfficer {}

export interface SunbizSearchHit {
  name: string;
  document_number: string;
  status: string;
  detail_url: string;
  aggregate_id: string | null;
  search_name_order: string | null;
}

export interface SunbizEntity {
  document_number: string;
  name: string;
  filing_type: string | null;
  status: string;
  registered_agent: string | null;
  officers: SunbizOfficer[];
  source: 'sunbiz' | 'sunbizdaily' | 'sunbizdata';
}

export type FloridaRunKeyStatus =
  | 'unused'
  | 'ok'
  | 'salvaged'
  | 'malformed'
  | 'rejected_falling_back_to_html';

export class FloridaSunbizError extends Error {
  readonly status: number;
  readonly kind: 'search' | 'detail';
  readonly blocked: boolean;
  readonly authFailure: boolean;

  constructor(
    kind: 'search' | 'detail',
    status: number,
    message: string,
    opts: { blocked?: boolean; authFailure?: boolean } | boolean = {},
  ) {
    super(message);
    this.name = 'FloridaSunbizError';
    this.kind = kind;
    this.status = status;
    const flags = typeof opts === 'boolean' ? { blocked: opts } : opts;
    this.blocked = Boolean(flags.blocked);
    this.authFailure = Boolean(flags.authFailure);
  }

  get permanent(): boolean {
    if (this.blocked || this.authFailure) return false;
    if (this.status === 429) return false;
    return this.status >= 400 && this.status < 500;
  }
}

let injectedFetch: FetchLike | null = null;
let cachedSource: 'html' | 'api' | null = null;
let htmlBlocked = false;
let apiRejected = false;
let runKeyStatus: FloridaRunKeyStatus = 'unused';

export function setFloridaSunbizFetch(fn: FetchLike | null): void {
  injectedFetch = fn;
}

export function resetFloridaSunbizSource(): void {
  cachedSource = null;
  htmlBlocked = false;
  apiRejected = false;
  runKeyStatus = 'unused';
}

export function floridaSunbizKeyStatus(): FloridaRunKeyStatus {
  return runKeyStatus;
}

export function isRetryableFloridaOfficerMatch(match: string | null | undefined): boolean {
  return match == null || match === '' || match === 'unavailable' || match === 'error';
}

function getFetch(): FetchLike {
  return injectedFetch ?? fetch;
}

export function inspectConfiguredFloridaSosKey() {
  return inspectFloridaSosKey(getSetting('florida_sos_api_key'));
}

export function hasFloridaSosKey(): boolean {
  return Boolean(inspectConfiguredFloridaSosKey().usable) && !apiRejected;
}

/** Public Sunbiz HTML is attempted first; a key is only required if Cloudflare blocks this host. */
export function hasFloridaSunbiz(): boolean {
  return true;
}

export function isFloridaRowState(state: string | null | undefined): boolean {
  const st = String(state || '').trim().toUpperCase();
  return st === 'FL' || st === 'FLORIDA';
}

export function looksLikeCloudflareChallenge(status: number, body: string): boolean {
  if (status === 403 || status === 401) return true;
  return /just a moment|cf-mitigated|challenge-platform|performing security verification|enable javascript and cookies to continue/i.test(
    body,
  );
}

export function cleanSearchTerm(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, SEARCH_TERM_MAX);
}

export function companyKey(s: string): string {
  return s
    .toUpperCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\b(THE|LLC|L L C|INC|INCORPORATED|LTD|LP|LLP|CO|COMPANY|CORP|CORPORATION)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sunbiz officer names are usually `LAST, FIRST MIDDLE`. */
export function normalizeSunbizPersonName(name: string): string {
  const t = name.replace(/\s+/g, ' ').trim();
  if (!t.includes(',')) return t;
  const [last, rest] = t.split(',', 2);
  return `${(rest || '').trim()} ${last.trim()}`.replace(/\s+/g, ' ').trim();
}

const TITLE_ABBR: Record<string, string> = {
  P: 'President',
  T: 'Treasurer',
  C: 'Chairman',
  V: 'Vice President',
  S: 'Secretary',
  D: 'Director',
  MGR: 'Manager',
  MGRM: 'Manager',
  AMBR: 'Authorized Member',
  AR: 'Authorized Representative',
};

export function expandOfficerTitle(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return t;
  const key = t.toUpperCase().replace(/\./g, '');
  return TITLE_ABBR[key] || t;
}

export function isActiveStatus(status: string): boolean {
  const s = status.trim().toUpperCase();
  return s === 'ACTIVE' || s === 'A';
}

function decodeHtml(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function tidy(s: string): string {
  return decodeHtml(s).replace(/\s+/g, ' ').trim();
}

function stripTags(html: string): string {
  return decodeHtml(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n');
}

function absUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href.replace(/&amp;/g, '&');
  return `${SUNBIZ_ORIGIN}${href.startsWith('/') ? href : `/${href}`}`.replace(/&amp;/g, '&');
}

function queryParam(url: string, key: string): string | null {
  try {
    const parsed = new URL(url, SUNBIZ_ORIGIN);
    return parsed.searchParams.get(key) || parsed.searchParams.get(key.toLowerCase());
  } catch {
    const re = new RegExp(`[?&]${key}=([^&]+)`, 'i');
    const m = url.match(re);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  }
}

function isTrademarkHit(hit: SunbizSearchHit): boolean {
  if ((hit.aggregate_id || '').toLowerCase().startsWith('trade-')) return true;
  return /^T\d+$/i.test(hit.document_number);
}

export function parseSearchResultsHtml(html: string): SunbizSearchHit[] {
  if (/noResults=True/i.test(html)) return [];
  const hits: SunbizSearchHit[] = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  for (const row of rows) {
    const hrefMatch = row.match(/href="([^"]*SearchResultDetail[^"]*)"/i);
    if (!hrefMatch) continue;
    const detailUrl = absUrl(hrefMatch[1]);
    const nameMatch = row.match(/<a[^>]*>([^<]+)<\/a>/i);
    const docMatch =
      row.match(/class="medium-width">([^<]+)/i) || row.match(/<\/a>[\s\S]*?<td[^>]*>\s*([A-Z0-9]+)\s*</i);
    const statusMatch =
      row.match(/class="small-width">([^<]+)/i) ||
      row.match(/<\/td>\s*<td[^>]*>\s*([A-Z0-9/ ]+)\s*<\/td>\s*<\/tr>/i);
    const name = tidy(nameMatch?.[1] || '');
    const documentNumber = tidy(docMatch?.[1] || queryParam(detailUrl, 'searchNameOrder') || '');
    if (!name || !documentNumber) continue;
    const docFromOrder = (queryParam(detailUrl, 'searchNameOrder') || '').split(/\s+/).pop() || documentNumber;
    hits.push({
      name,
      document_number: /^[A-Z0-9]+$/i.test(documentNumber) ? documentNumber : docFromOrder,
      status: tidy(statusMatch?.[1] || ''),
      detail_url: detailUrl,
      aggregate_id: queryParam(detailUrl, 'aggregateId'),
      search_name_order: queryParam(detailUrl, 'searchNameOrder'),
    });
  }
  return hits.filter((h) => !isTrademarkHit(h));
}

function labeledValue(html: string, label: string): string | null {
  const re = new RegExp(
    `${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?<\\/[^>]+>\\s*(?:<[^>]+>\\s*)*([^<]+)`,
    'i',
  );
  const m = html.match(re);
  if (!m) return null;
  const v = tidy(m[1]);
  if (!v || /^none$/i.test(v)) return null;
  return v;
}

function sliceBetween(html: string, start: string, end: string): string {
  const s = html.search(new RegExp(start, 'i'));
  if (s < 0) return '';
  const rest = html.slice(s);
  const e = rest.search(new RegExp(end, 'i'));
  return e > 0 ? rest.slice(0, e) : rest;
}

function parseCityStateZip(line: string): { city: string | null; state: string | null; zip: string | null } {
  const m = line.match(/^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
  if (!m) return { city: null, state: null, zip: null };
  return { city: m[1].trim(), state: m[2].toUpperCase(), zip: m[3] };
}

function parseOfficerChunk(chunk: string, registeredAgent: string | null): SunbizOfficer | null {
  const text = stripTags(chunk);
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!lines.length) return null;
  let title = expandOfficerTitle(lines[0] || '');
  let nameLine = lines[1] || '';
  // `Title P JOHN DOE` on one line after split.
  if (!nameLine && /\s/.test(title)) {
    const parts = title.split(/\s+/);
    title = expandOfficerTitle(parts[0] || '');
    nameLine = parts.slice(1).join(' ');
  }
  if (!nameLine) return null;
  const name = normalizeSunbizPersonName(nameLine);
  if (!name) return null;
  const addrLines = lines.slice(2);
  const last = addrLines[addrLines.length - 1] || '';
  const loc = parseCityStateZip(last);
  const street = addrLines.length > 1 ? addrLines.slice(0, -1).join(', ') : addrLines[0] || null;
  return {
    name,
    title,
    year: null,
    street,
    city: loc.city,
    state: loc.state,
    zip: loc.zip,
    source: 'sunbiz',
    is_registered_agent: isRegisteredAgentName(name) || (!!registeredAgent && namesLooselyMatch(name, registeredAgent)),
  };
}

export function parseDetailHtml(html: string): SunbizEntity | null {
  if (looksLikeCloudflareChallenge(200, html) && /corporationName/i.test(html) === false) return null;
  const names = [...html.matchAll(/class="corporationName"[^>]*>([^<]+)/gi)].map((m) => tidy(m[1]));
  const filingType = names[0] || labeledValue(html, 'Filing Type') || null;
  const name = names[1] || names[0] || labeledValue(html, 'Name') || '';
  const documentNumber = labeledValue(html, 'Document Number') || '';
  if (!name && !documentNumber) return null;
  const status = labeledValue(html, 'Status') || '';
  const raHtml = sliceBetween(html, 'Registered Agent Name', 'Officer/Director') || sliceBetween(html, 'Registered Agent Name', 'Annual Reports');
  const raLines = stripTags(raHtml)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/registered agent name/i.test(l) && !/^changed:/i.test(l));
  const registeredAgent = raLines[0] ? normalizeSunbizPersonName(raLines[0]) : null;
  const officerHtml =
    sliceBetween(html, 'Officer/Director Detail', 'Annual Reports') ||
    sliceBetween(html, 'Officer/Director Detail', 'Document Images') ||
    '';
  const chunks = officerHtml.split(/Title(?:&nbsp;|\s)+/i).slice(1);
  const officers = chunks
    .map((chunk) => parseOfficerChunk(chunk, registeredAgent))
    .filter((o): o is SunbizOfficer => Boolean(o));
  return {
    document_number: documentNumber,
    name,
    filing_type: filingType,
    status,
    registered_agent: registeredAgent,
    officers,
    source: 'sunbiz',
  };
}

export function rankSunbizHits(company: string, hits: SunbizSearchHit[]): SunbizSearchHit[] {
  const ranked = rankFranchiseHits(
    company,
    hits.map((h) => ({ taxpayerId: h.document_number, name: h.name })),
  );
  const byId = new Map(hits.map((h) => [h.document_number, h]));
  const scored = ranked
    .map((r) => byId.get(r.taxpayerId))
    .filter((h): h is SunbizSearchHit => Boolean(h));
  return scored.sort((a, b) => Number(isActiveStatus(b.status)) - Number(isActiveStatus(a.status)));
}

export function sunbizEntityToComptroller(entity: SunbizEntity): ComptrollerEntity {
  return {
    taxpayer_id: entity.document_number,
    name: entity.name,
    dba: null,
    sos_file_number: entity.document_number,
    right_to_transact: entity.status,
    registered_agent: entity.registered_agent,
    officers: entity.officers,
  };
}

export function pickSunbizOwnerOfficer(contactName: string, entity: SunbizEntity) {
  return pickOwnerOfficer(contactName, sunbizEntityToComptroller(entity));
}

function htmlHeaders(): HeadersInit {
  return {
    Accept: 'text/html,application/xhtml+xml',
    'User-Agent': 'PermitParcelMCP/2.0 (Florida officer enrichment; public records)',
  };
}

async function readText(url: string, init?: RequestInit): Promise<{ res: Response; body: string }> {
  const res = await getFetch()(url, init);
  const body = await res.text();
  return { res, body };
}

function throwIfBlocked(kind: 'search' | 'detail', res: Response, body: string): void {
  if (!looksLikeCloudflareChallenge(res.status, body)) return;
  throw new FloridaSunbizError(
    kind,
    res.status,
    'Florida Sunbiz blocked this host (Cloudflare). Set florida_sos_api_key via set_enrichment_api_key — Sunbiz Daily is free with a registered X-API-Key; sunbizdata.com keys start with sb_.',
    true,
  );
}

async function searchSunbizHtml(name: string): Promise<SunbizSearchHit[]> {
  const q = cleanSearchTerm(name);
  if (q.length < 2) return [];
  const url = new URL(SUNBIZ_SEARCH);
  url.searchParams.set('inquiryType', 'EntityName');
  url.searchParams.set('searchTerm', q);
  const { res, body } = await readText(url.toString(), { headers: htmlHeaders(), redirect: 'follow' });
  throwIfBlocked('search', res, body);
  if (res.status >= 400) {
    throw new FloridaSunbizError('search', res.status, `Florida Sunbiz search ${res.status}`);
  }
  if (/noResults=True/i.test(res.url) || /noResults=True/i.test(body)) return [];
  return parseSearchResultsHtml(body);
}

async function getSunbizHtml(hit: SunbizSearchHit): Promise<SunbizEntity | null> {
  const { res, body } = await readText(hit.detail_url, { headers: htmlHeaders() });
  throwIfBlocked('detail', res, body);
  if (res.status === 404) return null;
  if (res.status >= 400) {
    throw new FloridaSunbizError('detail', res.status, `Florida Sunbiz detail ${res.status}`);
  }
  const entity = parseDetailHtml(body);
  if (entity && !entity.document_number) entity.document_number = hit.document_number;
  if (entity && !entity.name) entity.name = hit.name;
  return entity;
}

function sosKey(): string {
  return inspectConfiguredFloridaSosKey().usable;
}

function isApiAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function throwApiError(
  kind: 'search' | 'detail',
  provider: 'sunbizdata' | 'Sunbiz Daily',
  status: number,
  body: unknown,
  statusText: string,
): never {
  throw new FloridaSunbizError(
    kind,
    status,
    `${provider} ${kind} ${status}: ${formatApiError(body, statusText || String(status))}`,
    { authFailure: isApiAuthStatus(status) },
  );
}

async function readJson(url: string, headers: HeadersInit): Promise<{ res: Response; body: Record<string, unknown> | null }> {
  const res = await getFetch()(url, { headers });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { res, body };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function officerFromApi(raw: unknown, registeredAgent: string | null, source: string): SunbizOfficer | null {
  const o = asRecord(raw);
  if (!o) return null;
  const name = normalizeSunbizPersonName(str(o.name || o.officerName || o.officer_name));
  if (!name) return null;
  const addr = asRecord(o.address) || asRecord(o.principal_address);
  return {
    name,
    title: expandOfficerTitle(str(o.title || o.officerTitle || o.officer_title)),
    year: null,
    street: str(o.street || o.address_1 || addr?.address_1) || null,
    city: str(o.city || addr?.city) || null,
    state: str(o.state || addr?.state) || null,
    zip: str(o.zip || addr?.zip) || null,
    source,
    is_registered_agent: isRegisteredAgentName(name) || (!!registeredAgent && namesLooselyMatch(name, registeredAgent)),
  };
}

function entityFromSunbizdaily(raw: Record<string, unknown>): SunbizEntity {
  const ra = asRecord(raw.registered_agent);
  const registeredAgent = str(ra?.name) || null;
  const officers = Array.isArray(raw.officers)
    ? raw.officers
        .map((o) => officerFromApi(o, registeredAgent, 'sunbizdaily'))
        .filter((o): o is SunbizOfficer => Boolean(o))
    : [];
  return {
    document_number: str(raw.corporation_number || raw.document_number),
    name: str(raw.corporation_name || raw.name),
    filing_type: str(raw.filing_type_display || raw.filing_type) || null,
    status: str(raw.status),
    registered_agent: registeredAgent,
    officers,
    source: 'sunbizdaily',
  };
}

function entityFromSunbizdata(raw: Record<string, unknown>): SunbizEntity {
  const ra = asRecord(raw.registeredAgent) || asRecord(raw.registered_agent);
  const registeredAgent = str(ra?.name || raw.registeredAgentName) || null;
  const list = (raw.officers || raw.Officers || []) as unknown[];
  const officers = Array.isArray(list)
    ? list.map((o) => officerFromApi(o, registeredAgent, 'sunbizdata')).filter((o): o is SunbizOfficer => Boolean(o))
    : [];
  return {
    document_number: str(raw.documentNumber || raw.document_number),
    name: str(raw.corporationName || raw.corporation_name || raw.name),
    filing_type: str(raw.filingType || raw.filing_type) || null,
    status: str(raw.status),
    registered_agent: registeredAgent,
    officers,
    source: 'sunbizdata',
  };
}

async function searchSunbizdaily(name: string, key: string): Promise<SunbizSearchHit[]> {
  const url = new URL(`${SUNBIZDAILY_BASE}/filings/`);
  url.searchParams.set('corporation_name', cleanSearchTerm(name));
  url.searchParams.set('per_page', '20');
  url.searchParams.set('include', 'officers,registered_agent');
  const { res, body } = await readJson(url.toString(), {
    Accept: 'application/json',
    'X-API-Key': key,
    'User-Agent': 'PermitParcelMCP/2.0',
  });
  if (!res.ok) {
    throwApiError('search', 'Sunbiz Daily', res.status, body, res.statusText);
  }
  const filings = Array.isArray(body?.filings) ? body.filings : [];
  return filings
    .map((row) => {
      const r = asRecord(row);
      if (!r) return null;
      const documentNumber = str(r.corporation_number);
      const entityName = str(r.corporation_name);
      if (!documentNumber || !entityName) return null;
      const hit: SunbizSearchHit = {
        name: entityName,
        document_number: documentNumber,
        status: str(r.status),
        detail_url: `${SUNBIZDAILY_BASE}/filings/${encodeURIComponent(documentNumber)}/`,
        aggregate_id: null,
        search_name_order: null,
      };
      return hit;
    })
    .filter((h): h is SunbizSearchHit => Boolean(h));
}

async function getSunbizdaily(hit: SunbizSearchHit, key: string): Promise<SunbizEntity | null> {
  const { res, body } = await readJson(hit.detail_url, {
    Accept: 'application/json',
    'X-API-Key': key,
    'User-Agent': 'PermitParcelMCP/2.0',
  });
  if (res.status === 404) return null;
  if (!res.ok || !body) {
    throwApiError('detail', 'Sunbiz Daily', res.status, body, res.statusText);
  }
  return entityFromSunbizdaily(body);
}

async function searchSunbizdata(name: string, key: string): Promise<SunbizSearchHit[]> {
  const url = new URL(`${SUNBIZDATA_BASE}/corporations/search/name`);
  url.searchParams.set('name', cleanSearchTerm(name));
  const { res, body } = await readJson(url.toString(), {
    Accept: 'application/json',
    'x-api-key': key,
    'User-Agent': 'PermitParcelMCP/2.0',
  });
  if (!res.ok) {
    throwApiError('search', 'sunbizdata', res.status, body, res.statusText);
  }
  const results = Array.isArray(body?.results) ? body.results : Array.isArray(body?.data) ? body.data : [];
  return results
    .map((row) => {
      const r = asRecord(row);
      if (!r) return null;
      const documentNumber = str(r.documentNumber || r.document_number);
      const entityName = str(r.corporationName || r.corporation_name || r.name);
      if (!documentNumber || !entityName) return null;
      const hit: SunbizSearchHit = {
        name: entityName,
        document_number: documentNumber,
        status: str(r.status),
        detail_url: `${SUNBIZDATA_BASE}/corporations/${encodeURIComponent(documentNumber)}`,
        aggregate_id: null,
        search_name_order: null,
      };
      return hit;
    })
    .filter((h): h is SunbizSearchHit => Boolean(h));
}

async function getSunbizdata(hit: SunbizSearchHit, key: string): Promise<SunbizEntity | null> {
  const { res, body } = await readJson(hit.detail_url, {
    Accept: 'application/json',
    'x-api-key': key,
    'User-Agent': 'PermitParcelMCP/2.0',
  });
  if (res.status === 404) return null;
  if (!res.ok || !body) {
    throwApiError('detail', 'sunbizdata', res.status, body, res.statusText);
  }
  return entityFromSunbizdata(body);
}

async function searchViaApi(name: string): Promise<SunbizSearchHit[]> {
  const key = sosKey();
  if (!key) {
    throw new FloridaSunbizError(
      'search',
      403,
      'Florida Sunbiz blocked this host (Cloudflare). Set florida_sos_api_key via set_enrichment_api_key.',
      { blocked: true },
    );
  }
  return isSunbizdataKey(key) ? searchSunbizdata(name, key) : searchSunbizdaily(name, key);
}

async function getViaApi(hit: SunbizSearchHit): Promise<SunbizEntity | null> {
  const key = sosKey();
  if (!key) {
    throw new FloridaSunbizError('detail', 403, 'florida_sos_api_key is not set.', { blocked: true });
  }
  return isSunbizdataKey(key) ? getSunbizdata(hit, key) : getSunbizdaily(hit, key);
}

function markApiRejected(): void {
  apiRejected = true;
  cachedSource = cachedSource === 'api' ? null : cachedSource;
  if (runKeyStatus === 'ok' || runKeyStatus === 'salvaged' || runKeyStatus === 'unused') {
    runKeyStatus = 'rejected_falling_back_to_html';
  }
}

function bothPathsFailedError(htmlErr: unknown, apiErr?: unknown): FloridaSunbizError {
  const htmlMsg = htmlErr instanceof Error ? htmlErr.message : 'Florida Sunbiz HTML failed';
  const apiMsg = apiErr instanceof Error ? apiErr.message : '';
  const message = apiMsg ? `${htmlMsg} · ${apiMsg}` : htmlMsg;
  const authFailure = apiErr instanceof FloridaSunbizError && apiErr.authFailure;
  return new FloridaSunbizError('search', 403, message, { blocked: true, authFailure });
}

async function searchHtmlRanked(name: string, q: string): Promise<SunbizSearchHit[]> {
  const hits = await searchSunbizHtml(q);
  htmlBlocked = false;
  cachedSource = 'html';
  return rankSunbizHits(name, hits);
}

async function searchApiRanked(name: string, q: string): Promise<SunbizSearchHit[]> {
  const hits = await searchViaApi(q);
  cachedSource = 'api';
  return rankSunbizHits(name, hits);
}

export async function prepareFloridaSunbizRun(): Promise<{
  key_status: FloridaRunKeyStatus;
  api_usable: boolean;
}> {
  resetFloridaSunbizSource();
  await loadAppSettings();
  const info = inspectConfiguredFloridaSosKey();
  if (info.status === 'missing') {
    runKeyStatus = 'unused';
    return { key_status: 'unused', api_usable: false };
  }
  if (info.status === 'malformed') {
    runKeyStatus = 'malformed';
    apiRejected = true;
    return { key_status: 'malformed', api_usable: false };
  }
  runKeyStatus = info.status === 'salvaged' ? 'salvaged' : 'ok';
  try {
    await searchViaApi('TAMPA');
  } catch (err) {
    if (err instanceof FloridaSunbizError && err.authFailure) {
      markApiRejected();
      return { key_status: runKeyStatus, api_usable: false };
    }
    // Non-auth probe failures still allow API as a Cloudflare fallback during the row loop.
  }
  return { key_status: runKeyStatus, api_usable: Boolean(sosKey()) && !apiRejected };
}

export async function searchSunbizEntities(name: string): Promise<SunbizSearchHit[]> {
  await loadAppSettings();
  const q = cleanSearchTerm(name);
  if (q.length < 2) return [];

  let htmlErr: unknown = null;
  if (cachedSource !== 'api' && !htmlBlocked) {
    try {
      return await searchHtmlRanked(name, q);
    } catch (err) {
      if (!(err instanceof FloridaSunbizError && err.blocked)) throw err;
      htmlBlocked = true;
      htmlErr = err;
    }
  }

  if (sosKey() && !apiRejected) {
    try {
      return await searchApiRanked(name, q);
    } catch (err) {
      if (err instanceof FloridaSunbizError && err.authFailure) {
        markApiRejected();
        try {
          return await searchHtmlRanked(name, q);
        } catch (fallbackErr) {
          if (fallbackErr instanceof FloridaSunbizError && fallbackErr.blocked) {
            htmlBlocked = true;
            throw bothPathsFailedError(fallbackErr, err);
          }
          throw fallbackErr;
        }
      }
      throw err;
    }
  }

  if (htmlErr) throw htmlErr instanceof FloridaSunbizError ? htmlErr : bothPathsFailedError(htmlErr);
  return searchHtmlRanked(name, q);
}

export async function getSunbizEntity(hit: SunbizSearchHit): Promise<SunbizEntity | null> {
  await loadAppSettings();
  if (cachedSource === 'api' && sosKey() && !apiRejected) {
    try {
      return await getViaApi(hit);
    } catch (err) {
      if (err instanceof FloridaSunbizError && err.authFailure) {
        markApiRejected();
        return getSunbizHtml(hit);
      }
      throw err;
    }
  }
  try {
    const entity = await getSunbizHtml(hit);
    cachedSource = cachedSource ?? 'html';
    return entity;
  } catch (err) {
    if (err instanceof FloridaSunbizError && err.blocked) {
      htmlBlocked = true;
      if (!sosKey() || apiRejected) throw err;
      try {
        cachedSource = 'api';
        return await getViaApi(hit);
      } catch (apiErr) {
        if (apiErr instanceof FloridaSunbizError && apiErr.authFailure) {
          markApiRejected();
        }
        throw apiErr;
      }
    }
    throw err;
  }
}

export function floridaOfficerGapMs(): number {
  return cachedSource === 'api' && !apiRejected ? 20 : HTML_GAP_MS;
}
