import { getSetting, loadAppSettings } from './appSettings.js';
import { contactLooksLikePerson } from './contactScore.js';

/** Official website proxy — same officer data, no API key. */
const PUBLIC_BASE = 'https://comptroller.texas.gov/data-search/franchise-tax';
/** Gated API Gateway. Cayden's Tax Account key currently 403s here. */
const GATED_BASE = 'https://api.comptroller.texas.gov/public-data/v1/public';

export interface ComptrollerOfficer {
  name: string;
  title: string;
  year: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  source: string | null;
  is_registered_agent: boolean;
}

export interface ComptrollerEntity {
  taxpayer_id: string;
  name: string;
  dba: string | null;
  sos_file_number: string | null;
  right_to_transact: string | null;
  registered_agent: string | null;
  officers: ComptrollerOfficer[];
}

const AGENT_RE =
  /\b(c\s*t\s*corporation|ct corporation|corporation service company|\bcsc\b|legalzoom|incorp services|national registered agents|\bnrai\b|capitol corporate|cogency global|united agent group|northwest registered agent|registered agents?\s+inc|registered agent)\b/i;

export function isRegisteredAgentName(name: string): boolean {
  return AGENT_RE.test(name);
}

function headers(key: string): HeadersInit {
  return { Accept: 'application/json', 'x-api-key': key };
}

function cleanName(name: string): string {
  return name
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
}

export class TexasCpaError extends Error {
  readonly status: number;
  readonly kind: 'search' | 'detail';

  constructor(kind: 'search' | 'detail', status: number, message: string) {
    super(message);
    this.name = 'TexasCpaError';
    this.kind = kind;
    this.status = status;
  }

  /** 4xx other than rate-limit: do not retry; leave the unmatched queue. */
  get permanent(): boolean {
    if (this.status === 429) return false;
    return this.status >= 400 && this.status < 500;
  }

  /** Sole props / partnerships with a taxpayer number but no franchise-tax account. */
  get notFranchiseTax(): boolean {
    return isNonFranchiseTaxpayerMessage(this.message);
  }
}

/** Comptroller returns the reason on `error`, not `message`. */
export function cpaErrorText(body: Record<string, unknown> | null, fallback: string): string {
  if (!body) return fallback;
  for (const candidate of [body.error, body.message, body.detail]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

export function isNonFranchiseTaxpayerMessage(msg: string): boolean {
  return /not set up for franchise tax/i.test(msg);
}

async function readJson(url: string, key?: string) {
  const hdrs: HeadersInit = {
    Accept: 'application/json',
    'User-Agent': 'PermitParcelMCP/2.0 (owner-cell enrichment)',
  };
  if (key) Object.assign(hdrs, headers(key));
  const res = await fetch(url, { headers: hdrs });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { res, body };
}

export async function searchFranchiseEntities(name: string): Promise<Array<{ taxpayerId: string; name: string }>> {
  await loadAppSettings();
  const q = cleanName(name);
  if (q.length < 2) return [];
  const publicUrl = new URL(PUBLIC_BASE);
  publicUrl.searchParams.set('name', q);
  let { res, body } = await readJson(publicUrl.toString());
  if (!res.ok) {
    const key = getSetting('texas_cpa_api_key');
    if (key) {
      const gated = new URL(`${GATED_BASE}/franchise-tax-list`);
      gated.searchParams.set('name', q);
      ({ res, body } = await readJson(gated.toString(), key));
    }
  }
  if (!res.ok) {
    throw new TexasCpaError(
      'search',
      res.status,
      `Texas CPA search ${res.status}: ${cpaErrorText(body, res.statusText)}`,
    );
  }
  const data = (body?.data as Array<{ taxpayerId?: string; name?: string }> | undefined) ?? [];
  return data
    .filter((r) => r.taxpayerId && r.name)
    .map((r) => ({ taxpayerId: String(r.taxpayerId), name: String(r.name) }));
}

export async function getFranchiseAccount(taxpayerId: string): Promise<ComptrollerEntity | null> {
  await loadAppSettings();
  const id = taxpayerId.replace(/\D/g, '').padStart(11, '0').slice(-11);
  let { res, body } = await readJson(`${PUBLIC_BASE}/${id}`);
  if (!res.ok && res.status !== 404) {
    const key = getSetting('texas_cpa_api_key');
    if (key) ({ res, body } = await readJson(`${GATED_BASE}/franchise-tax/${id}`, key));
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new TexasCpaError(
      'detail',
      res.status,
      `Texas CPA detail ${res.status}: ${cpaErrorText(body, res.statusText)}`,
    );
  }
  const d = body?.data as {
    taxpayerId?: string;
    name?: string;
    dbaName?: string;
    sosFileNumber?: string;
    rightToTransactTX?: string;
    registeredAgentName?: string;
    officerInfo?: Array<{
      AGNT_NM?: string;
      AGNT_TITL_TX?: string;
      AGNT_ACTV_YR?: string;
      AD_STR_POB_TX?: string;
      CITY_NM?: string;
      ST_CD?: string;
      AD_ZP?: string;
      SOURCE?: string;
    }>;
  } | undefined;
  if (!d) return null;
  const ra = d.registeredAgentName || '';
  return {
    taxpayer_id: String(d.taxpayerId || id),
    name: d.name || '',
    dba: d.dbaName || null,
    sos_file_number: d.sosFileNumber || null,
    right_to_transact: d.rightToTransactTX || null,
    registered_agent: ra || null,
    officers: (d.officerInfo ?? []).map((o) => {
      const name = (o.AGNT_NM || '').trim();
      return {
        name,
        title: (o.AGNT_TITL_TX || '').trim(),
        year: o.AGNT_ACTV_YR || null,
        street: o.AD_STR_POB_TX || null,
        city: o.CITY_NM || null,
        state: o.ST_CD || null,
        zip: o.AD_ZP || null,
        source: o.SOURCE || null,
        is_registered_agent: isRegisteredAgentName(name) || (!!ra && namesLooselyMatch(name, ra)),
      };
    }),
  };
}

function normPerson(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\b(JR|SR|II|III|IV|LLC|INC|LP|LTD)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function personTokens(s: string): string[] {
  return normPerson(s).split(' ').filter(Boolean);
}

function firstLast(s: string): { first: string; last: string } {
  const tokens = personTokens(s);
  const long = tokens.filter((t) => t.length > 1);
  return {
    first: tokens[0] || '',
    last: long[long.length - 1] || tokens[tokens.length - 1] || '',
  };
}

/** Edit distance. Exported for tests. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + cost);
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

function fuzzyTokenMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < 4) return false;
  const dist = levenshtein(a, b);
  if (maxLen >= 8) return dist <= 2;
  return dist <= 1;
}

export function namesLooselyMatch(a: string, b: string): boolean {
  const left = normPerson(a);
  const right = normPerson(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const lf = firstLast(left);
  const rf = firstLast(right);
  if (lf.last && lf.last === rf.last && lf.first[0] && lf.first[0] === rf.first[0]) return true;
  if (fuzzyTokenMatch(lf.first, rf.first) && fuzzyTokenMatch(lf.last, rf.last)) return true;
  if (lf.first && lf.first === rf.first && fuzzyTokenMatch(lf.last, rf.last)) return true;
  if (lf.last && lf.last === rf.last && fuzzyTokenMatch(lf.first, rf.first)) return true;
  return false;
}

function companyKey(s: string): string {
  return s
    .toUpperCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\b(THE|LLC|L L C|INC|INCORPORATED|LTD|LP|LLP|CO|COMPANY|CORP|CORPORATION)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BUSINESS_HINT =
  /\b(LLC|L L C|INC|INCORPORATED|LTD|LP|LLP|CO|COMPANY|CORP|CORPORATION|CONSTRUCTION|ROOFING|PLUMBING|ELECTRIC|ELECTRICAL|SERVICES?|GROUP|HOLDINGS|ENTERPRISES|CONTRACTORS?|CONTRACTING|BUILDERS?|REMODEL|HVAC|PAINTING|FLOORING|CONCRETE|MASONRY|LANDSCAP\w*|POOL|FENCE|WINDOWS?|DOORS?|SIDING|DRYWALL|TRUCKING|TRANSPORT|LOGISTICS|HEATING|COOLING)\b/i;

/** "ABEL GARCIA" / "ALEJANDRO MARTINEZ" — not an LLC/trade name. */
export function looksLikePersonName(name: string): boolean {
  const key = companyKey(name);
  const tokens = key.split(' ').filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return false;
  if (BUSINESS_HINT.test(name) || BUSINESS_HINT.test(key)) return false;
  return tokens.every((t) => /^[A-Z]+$/.test(t) && t.length >= 2 && t.length <= 16);
}

function scoreFranchiseHit(target: string, hitName: string, personStyle: boolean): number {
  const key = companyKey(hitName);
  if (!key) return 0;
  if (key === target) return 100;
  if (personStyle) {
    // Person-style company names must not match "NAME AND PARTNER" / "NAME TRUCKING LLC".
    if (target.length >= 8 && levenshtein(key, target) <= 1) return 95;
    return 0;
  }
  if (key.includes(target) || target.includes(key)) return 80;
  const words = target.split(' ').filter((w) => w.length > 2);
  return words.filter((w) => key.includes(w)).length * 10;
}

export type RankedFranchiseHit = { taxpayerId: string; name: string; score: number };

/** Rank CPA search hits. Person-style queries only keep exact / 1-char matches. */
export function rankFranchiseHits(
  company: string,
  hits: Array<{ taxpayerId: string; name: string }>,
): RankedFranchiseHit[] {
  if (!hits.length) return [];
  const personStyle = looksLikePersonName(company);
  const target = companyKey(company);
  const scored = hits
    .map((hit) => ({ ...hit, score: scoreFranchiseHit(target, hit.name, personStyle) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score);
  const min = personStyle ? 95 : 20;
  const viable = scored.filter((hit) => hit.score >= min);
  if (viable.length) return viable;
  if (!personStyle && hits.length === 1) return [{ ...hits[0]!, score: 1 }];
  return [];
}

export function pickBestEntity(
  company: string,
  hits: Array<{ taxpayerId: string; name: string }>,
): { taxpayerId: string; name: string } | null {
  return rankFranchiseHits(company, hits)[0] ?? null;
}

export function pickOwnerOfficer(
  contactName: string,
  entity: ComptrollerEntity,
  companyName = '',
): { officer: ComptrollerOfficer | null; match: 'match' | 'resolved' | 'different' | 'none' | 'agent' } {
  const real = entity.officers.filter((o) => o.name && !o.is_registered_agent);
  if (!real.length) {
    if (entity.officers.length) return { officer: entity.officers[0]!, match: 'agent' };
    return { officer: null, match: 'none' };
  }
  const ranked = [...real].sort((a, b) => rankTitle(b.title) - rankTitle(a.title));
  if (contactLooksLikePerson(contactName, companyName)) {
    const hit = real.find((o) => namesLooselyMatch(o.name, contactName));
    if (hit) return { officer: hit, match: 'match' };
    return { officer: ranked[0]!, match: 'different' };
  }
  // Company (or empty) contact: a returned officer is a resolution, not a mismatch.
  return { officer: ranked[0]!, match: 'resolved' };
}

function rankTitle(title: string): number {
  const t = title.toUpperCase();
  if (/\b(OWNER|PRESIDENT|MANAGING MEMBER|MANAGER|MEMBER|CEO|FOUNDER)\b/.test(t)) return 3;
  if (/\b(DIRECTOR|VP|VICE|SECRETARY|TREASURER)\b/.test(t)) return 2;
  return 1;
}

export function hasTexasCpa(): boolean {
  return true;
}
