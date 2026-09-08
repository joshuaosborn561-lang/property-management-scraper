import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isNationalChain, nationalChainHit } from '../lib/nationalChain.js';

export interface ShovelsContractor {
  id: string;
  name: string | null;
  business_name: string | null;
  dba: string | null;
  phone: string | null;
  primary_phone: string | null;
  email: string | null;
  primary_email: string | null;
  website: string | null;
  linkedin_url: string | null;
  employee_count: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  places: string[];
  permit_count: number | null;
  total_job_value: number | null;
  primary_industry: string | null;
  business_type: string | null;
}

export interface ContractorQuery {
  q?: string;
  place?: string;
  city?: string;
  state?: string;
  has_email?: boolean;
  has_phone?: boolean;
  has_website?: boolean;
  /** Inclusive lower bound on Shovels permit_count. Optional — do not use to drop small GCs. */
  min_permit_count?: number;
  /** Inclusive upper bound on Shovels permit_count. Optional. */
  max_permit_count?: number;
  /** Drop national GCs / public builders / franchise trades. Keeps local shops of any permit volume. */
  exclude_national_chains?: boolean;
  /** 1-based page */
  page?: number;
  /** page size, default 25, max 50 */
  page_size?: number;
}

export interface ContractorQueryResult {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  items: ShovelsContractor[];
}

let cache: ShovelsContractor[] | null = null;
let loadError: string | null = null;
let dataDirOverride: string | null = null;

/** Test-only: point the contractor store at a temp directory. */
export function setContractorsDataDirForTests(dir: string | null): void {
  dataDirOverride = dir;
  cache = null;
  loadError = null;
}

function dataDir(): string {
  return dataDirOverride ?? join(process.cwd(), 'data', 'shovels_commercial_contractors');
}

/** RFC4180-ish CSV parse (handles quotes and commas inside fields). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function emptyToNull(v: string | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t ? t : null;
}

function toNum(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function hasContact(v: string | null | undefined): boolean {
  return Boolean(v && String(v).trim());
}

export function loadShovelsContractors(force = false): ShovelsContractor[] {
  if (cache && !force) return cache;
  const csvPath = join(dataDir(), 'commercial_contractors_contacts.csv');
  if (!existsSync(csvPath)) {
    loadError = `Missing contractor dataset at ${csvPath}`;
    cache = [];
    return cache;
  }
  const text = readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  if (!rows.length) {
    cache = [];
    return cache;
  }
  const header = rows[0]!.map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const col = {
    id: idx('id'),
    name: idx('name'),
    business_name: idx('business_name'),
    dba: idx('dba'),
    phone: idx('phone'),
    primary_phone: idx('primary_phone'),
    email: idx('email'),
    primary_email: idx('primary_email'),
    website: idx('website'),
    linkedin_url: idx('linkedin_url'),
    employee_count: idx('employee_count'),
    address_street: idx('address_street'),
    address_city: idx('address_city'),
    address_state: idx('address_state'),
    address_zip: idx('address_zip'),
    places: idx('places'),
    permit_count: idx('permit_count'),
    total_job_value: idx('total_job_value'),
    primary_industry: idx('primary_industry'),
    business_type: idx('business_type'),
  };

  const out: ShovelsContractor[] = [];
  for (const r of rows.slice(1)) {
    if (!r.length || r.every((c) => !c?.trim())) continue;
    const get = (i: number) => emptyToNull(i >= 0 ? r[i] : undefined);
    const id = get(col.id);
    if (!id) continue;
    const placesRaw = get(col.places) || '';
    out.push({
      id,
      name: get(col.name),
      business_name: get(col.business_name),
      dba: get(col.dba),
      phone: get(col.phone),
      primary_phone: get(col.primary_phone),
      email: get(col.email),
      primary_email: get(col.primary_email),
      website: get(col.website),
      linkedin_url: get(col.linkedin_url),
      employee_count: get(col.employee_count),
      address_street: get(col.address_street),
      address_city: get(col.address_city),
      address_state: get(col.address_state),
      address_zip: get(col.address_zip),
      places: placesRaw
        ? placesRaw.split('|').map((p) => p.trim()).filter(Boolean)
        : [],
      permit_count: toNum(get(col.permit_count)),
      total_job_value: toNum(get(col.total_job_value)),
      primary_industry: get(col.primary_industry),
      business_type: get(col.business_type),
    });
  }
  cache = out;
  loadError = null;
  return cache;
}

export function invalidateShovelsContractorCache(): void {
  cache = null;
}

export function contractorsDataDir(): string {
  return dataDir();
}

export function contractorsStorePath(): string {
  return join(dataDir(), 'commercial_contractors_contacts.csv');
}

function mergePlaces(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...a, ...b]) {
    const key = p.trim();
    if (!key) continue;
    const low = key.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(key);
  }
  return out;
}

function prefer(a: string | null, b: string | null): string | null {
  return a && a.trim() ? a : b && b.trim() ? b : a ?? b ?? null;
}

/**
 * Upsert live-pull rows into the on-disk contractor store that
 * permits_contractors_query / save_calling_list read. Dedupes on Shovels id
 * and unions `places` so Denton_County appears alongside Dallas.
 */
export function upsertShovelsContractorsIntoStore(
  incoming: ShovelsContractor[],
): {
  written: number;
  inserted: number;
  updated: number;
  duplicates_skipped: number;
  total_after: number;
  path: string;
} {
  const existing = loadShovelsContractors(true);
  const byId = new Map<string, ShovelsContractor>();
  for (const row of existing) byId.set(row.id, { ...row, places: [...row.places] });

  let inserted = 0;
  let updated = 0;
  let duplicatesSkipped = 0;

  for (const row of incoming) {
    if (!row.id) continue;
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, { ...row, places: [...row.places] });
      inserted += 1;
      continue;
    }
    const places = mergePlaces(prev.places, row.places);
    const placeOnlyUpdate =
      places.length === prev.places.length &&
      places.every((p, i) => p.toLowerCase() === (prev.places[i] || '').toLowerCase());
    // Same id already present for this place → skip counting as write noise
    const alreadyHadPlace = row.places.every((p) =>
      prev.places.some((x) => x.toLowerCase() === p.toLowerCase()),
    );
    if (alreadyHadPlace) {
      duplicatesSkipped += 1;
      continue;
    }
    byId.set(row.id, {
      ...prev,
      name: prefer(row.name, prev.name),
      business_name: prefer(row.business_name, prev.business_name),
      dba: prefer(row.dba, prev.dba),
      phone: prefer(row.phone, prev.phone),
      primary_phone: prefer(row.primary_phone, prev.primary_phone),
      email: prefer(row.email, prev.email),
      primary_email: prefer(row.primary_email, prev.primary_email),
      website: prefer(row.website, prev.website),
      linkedin_url: prefer(row.linkedin_url, prev.linkedin_url),
      employee_count: prefer(row.employee_count, prev.employee_count),
      address_street: prefer(row.address_street, prev.address_street),
      address_city: prefer(row.address_city, prev.address_city),
      address_state: prefer(row.address_state, prev.address_state),
      address_zip: prefer(row.address_zip, prev.address_zip),
      places,
      permit_count: row.permit_count ?? prev.permit_count,
      total_job_value: row.total_job_value ?? prev.total_job_value,
      primary_industry: prefer(row.primary_industry, prev.primary_industry),
      business_type: prefer(row.business_type, prev.business_type),
    });
    updated += 1;
    void placeOnlyUpdate;
  }

  const merged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, 'commercial_contractors_contacts.csv');
  writeFileSync(path, contractorsToCsv(merged) + '\n', 'utf8');

  const byPlace: Record<string, number> = {};
  for (const c of merged) {
    for (const p of c.places) byPlace[p] = (byPlace[p] || 0) + 1;
  }
  const summaryPath = join(dir, 'summary.json');
  let prevSummary: Record<string, unknown> = {};
  if (existsSync(summaryPath)) {
    try {
      prevSummary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>;
    } catch {
      prevSummary = {};
    }
  }
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        ...prevSummary,
        unique_contractors: merged.length,
        places: byPlace,
        last_store_upsert_at: new Date().toISOString(),
        last_store_upsert: {
          inserted,
          updated,
          duplicates_skipped: duplicatesSkipped,
          incoming: incoming.length,
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  cache = merged;
  loadError = null;
  return {
    written: inserted + updated,
    inserted,
    updated,
    duplicates_skipped: duplicatesSkipped,
    total_after: merged.length,
    path,
  };
}

function matches(c: ShovelsContractor, q: ContractorQuery): boolean {
  if (q.place) {
    const place = q.place.trim();
    if (!c.places.some((p) => p.toLowerCase() === place.toLowerCase())) return false;
  }
  if (q.city) {
    if ((c.address_city || '').toLowerCase() !== q.city.trim().toLowerCase()) return false;
  }
  if (q.state) {
    if ((c.address_state || '').toLowerCase() !== q.state.trim().toLowerCase()) return false;
  }
  if (q.has_email === true) {
    if (!hasContact(c.email) && !hasContact(c.primary_email)) return false;
  }
  if (q.has_email === false) {
    if (hasContact(c.email) || hasContact(c.primary_email)) return false;
  }
  if (q.has_phone === true) {
    if (!hasContact(c.phone) && !hasContact(c.primary_phone)) return false;
  }
  if (q.has_phone === false) {
    if (hasContact(c.phone) || hasContact(c.primary_phone)) return false;
  }
  if (q.has_website === true && !hasContact(c.website)) return false;
  if (q.has_website === false && hasContact(c.website)) return false;
  if (!permitCountInRange(c.permit_count, q)) return false;
  if (q.exclude_national_chains === true && isNationalChain(c)) return false;
  if (q.q) {
    const needle = q.q.trim().toLowerCase();
    if (!needle) return true;
    const hay = [
      c.name,
      c.business_name,
      c.dba,
      c.email,
      c.primary_email,
      c.phone,
      c.primary_phone,
      c.website,
      c.address_city,
      ...c.places,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export function permitCountInRange(
  count: number | null | undefined,
  q: Pick<ContractorQuery, 'min_permit_count' | 'max_permit_count'>,
): boolean {
  const min = q.min_permit_count;
  const max = q.max_permit_count;
  if (min == null && max == null) return true;
  if (count == null || !Number.isFinite(count)) return false;
  if (min != null && count < min) return false;
  if (max != null && count > max) return false;
  return true;
}

export function shovelsIdFromPlaceId(placeId: string | null | undefined): string | null {
  if (!placeId) return null;
  return placeId.startsWith('shovels:') ? placeId.slice('shovels:'.length) : null;
}

export function permitCountByPlaceId(placeId: string | null | undefined): number | null {
  const id = shovelsIdFromPlaceId(placeId);
  if (!id) return null;
  return getShovelsContractor(id)?.permit_count ?? null;
}

export function nationalChainByPlaceId(placeId: string | null | undefined) {
  const id = shovelsIdFromPlaceId(placeId);
  if (!id) return { national_chain: false, reason: null as string | null };
  const row = getShovelsContractor(id);
  return row ? nationalChainHit(row) : { national_chain: false, reason: null as string | null };
}

export function matchingShovelsContractors(q: ContractorQuery = {}): ShovelsContractor[] {
  const rows = loadShovelsContractors().filter((c) => matches(c, q));
  if (q.min_permit_count == null && q.max_permit_count == null) return rows;
  return rows.slice().sort((a, b) => (a.permit_count ?? 0) - (b.permit_count ?? 0));
}

export function countMatchingShovelsContractors(q: ContractorQuery = {}): number {
  return matchingShovelsContractors(q).length;
}

export function queryShovelsContractors(q: ContractorQuery = {}): ContractorQueryResult {
  const filtered = matchingShovelsContractors(q);
  const pageSize = Math.min(50, Math.max(1, q.page_size ?? 25));
  const page = Math.max(1, q.page ?? 1);
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return {
    total,
    page,
    page_size: pageSize,
    total_pages: totalPages,
    items: filtered.slice(start, start + pageSize),
  };
}

export function getShovelsContractor(id: string): ShovelsContractor | null {
  return loadShovelsContractors().find((c) => c.id === id) ?? null;
}

export function sampleShovelsContractors(n = 20, q: Omit<ContractorQuery, 'page' | 'page_size'> = {}): {
  n: number;
  total_matching: number;
  items: ShovelsContractor[];
} {
  const all = loadShovelsContractors().filter((c) => matches(c, q));
  const size = Math.min(Math.max(1, n), 20);
  if (all.length <= size) {
    return { n: all.length, total_matching: all.length, items: all };
  }
  // Fisher-Yates partial shuffle for random sample
  const copy = all.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return { n: size, total_matching: all.length, items: copy.slice(0, size) };
}

export function shovelsContractorsSummary(): Record<string, unknown> {
  const all = loadShovelsContractors();
  const byPlace: Record<string, number> = {};
  let phone = 0;
  let email = 0;
  let both = 0;
  let neither = 0;
  let website = 0;
  let multiPlace = 0;
  for (const c of all) {
    for (const p of c.places) byPlace[p] = (byPlace[p] || 0) + 1;
    if (c.places.length > 1) multiPlace += 1;
    const hasP = hasContact(c.phone) || hasContact(c.primary_phone);
    const hasE = hasContact(c.email) || hasContact(c.primary_email);
    if (hasP) phone += 1;
    if (hasE) email += 1;
    if (hasP && hasE) both += 1;
    if (!hasP && !hasE) neither += 1;
    if (hasContact(c.website)) website += 1;
  }
  let meta: Record<string, unknown> = {};
  const summaryPath = join(dataDir(), 'summary.json');
  if (existsSync(summaryPath)) {
    try {
      meta = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>;
    } catch {
      meta = {};
    }
  }
  return {
    loaded: all.length > 0,
    load_error: loadError,
    unique_contractors: all.length,
    source: 'PermitStack / cached commercial contractors (permit activity)',
    filter: meta.filter ?? 'property_type=commercial',
    date_from: meta.date_from ?? null,
    date_to: meta.date_to ?? null,
    places: byPlace,
    multi_place: multiPlace,
    fill: {
      phone: { n: phone, pct: all.length ? round4(phone / all.length) : 0 },
      email: { n: email, pct: all.length ? round4(email / all.length) : 0 },
      phone_and_email: { n: both, pct: all.length ? round4(both / all.length) : 0 },
      neither: { n: neither, pct: all.length ? round4(neither / all.length) : 0 },
      website: { n: website, pct: all.length ? round4(website / all.length) : 0 },
    },
    national_chains: nationalChainSummary(all),
    query_hint:
      'Do not drop low-permit locals. Qualify with exclude_national_chains=true (known national GCs / public builders / franchise trades, or 5,000+ employees). Optional min/max permit_count if they name a band. Do not dump all rows into chat.',
  };
}

function nationalChainSummary(all: ShovelsContractor[]) {
  const chains = all.filter((c) => isNationalChain(c));
  const locals = all.filter((c) => !isNationalChain(c));
  const withPhone = (rows: ShovelsContractor[]) =>
    rows.filter((c) => hasContact(c.phone) || hasContact(c.primary_phone)).length;
  return {
    excluded_when_flag_true: chains.length,
    remaining: locals.length,
    remaining_with_phone: withPhone(locals),
    reasons: chains.reduce<Record<string, number>>((acc, c) => {
      const reason = nationalChainHit(c).reason || 'unknown';
      const key = reason.startsWith('employees:') ? 'employees_5000_plus' : 'known_name';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function contractorsToCsv(rows: ShovelsContractor[]): string {
  const headers = [
    'id',
    'name',
    'business_name',
    'dba',
    'phone',
    'primary_phone',
    'email',
    'primary_email',
    'website',
    'linkedin_url',
    'employee_count',
    'address_street',
    'address_city',
    'address_state',
    'address_zip',
    'places',
    'permit_count',
    'total_job_value',
    'primary_industry',
    'business_type',
  ] as const;
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(','),
    ...rows.map((r) =>
      headers
        .map((h) => {
          if (h === 'places') return esc(r.places.join('|'));
          return esc(r[h]);
        })
        .join(','),
    ),
  ].join('\n');
}
