import { randomUUID } from 'node:crypto';
import { parseCsv } from './shovelsContractors.js';
import { nationalChainHit } from '../lib/nationalChain.js';
import { supabaseTargetMeta } from '../lib/supabaseTarget.js';
import { hasSupabase, SCHEMA } from '../lib/supabase.js';
import { upsertJob, replaceLeads, upsertExport } from './syncToSupabase.js';
import { upsertCallingListMeta } from './callingLists.js';

const MAX_CSV_ROWS = 8000;

const HEADER_ALIASES: Record<string, string[]> = {
  company: [
    'company',
    'company_name',
    'business_name',
    'business',
    'contractor',
    'name',
    'firm',
  ],
  contact: ['contact', 'contact_name', 'owner', 'owner_name', 'person', 'dm'],
  phone: ['phone', 'primary_phone', 'mobile', 'cell', 'telephone'],
  email: ['email', 'primary_email'],
  city: ['city', 'address_city'],
  state: ['state', 'address_state'],
  zip: ['zip', 'zipcode', 'postal', 'address_zip'],
  website: ['website', 'url', 'web'],
  address: ['address', 'street', 'address_street'],
  id: ['id', 'place_id', 'shovels_id', 'contractor_id'],
  permit_count: ['permit_count', 'permits', 'reviews'],
};

function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function pickCol(headers: string[], aliases: string[]): number {
  const lower = headers.map(normHeader);
  for (const alias of aliases) {
    const i = lower.indexOf(alias);
    if (i >= 0) return i;
  }
  return -1;
}

export function mapCsvHeaders(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    map[key] = pickCol(headers, aliases);
  }
  return map;
}

export function csvRowsToLeads(csv: string): {
  leads: Record<string, unknown>[];
  headers: string[];
  skipped_empty: number;
  truncated: boolean;
} {
  const table = parseCsv(csv);
  if (!table.length) return { leads: [], headers: [], skipped_empty: 0, truncated: false };
  const headers = (table[0] ?? []).map((h) => h.trim());
  const cols = mapCsvHeaders(headers);
  if (cols.company < 0 && cols.contact < 0) {
    throw new Error(
      'CSV needs a company or contact column (company, business_name, name, contact_name, …)',
    );
  }
  const cell = (row: string[], idx: number) => (idx >= 0 ? (row[idx] || '').trim() : '');
  let skipped = 0;
  const leads: Record<string, unknown>[] = [];
  const body = table.slice(1);
  const truncated = body.length > MAX_CSV_ROWS;
  for (const row of body.slice(0, MAX_CSV_ROWS)) {
    if (!row.some((c) => c && c.trim())) {
      skipped += 1;
      continue;
    }
    const company = cell(row, cols.company) || cell(row, cols.contact);
    const contact = cell(row, cols.contact) || company;
    if (!company && !contact) {
      skipped += 1;
      continue;
    }
    const rawId = cell(row, cols.id);
    const placeId = rawId
      ? rawId.startsWith('shovels:') || rawId.startsWith('csv:')
        ? rawId
        : `csv:${rawId}`
      : `csv:${randomUUID().slice(0, 8)}`;
    const permitRaw = cell(row, cols.permit_count);
    const permitCount = permitRaw && /^\d+$/.test(permitRaw) ? Number(permitRaw) : null;
    const chain = nationalChainHit({
      name: contact,
      business_name: company,
      dba: null,
      employee_count: null,
    });
    leads.push({
      place_id: placeId,
      name: company,
      owner_name: contact,
      email: cell(row, cols.email),
      phone: cell(row, cols.phone),
      website: cell(row, cols.website),
      city: cell(row, cols.city),
      state: cell(row, cols.state),
      zip: cell(row, cols.zip),
      rating: '',
      reviews: permitCount != null ? String(permitCount) : '',
      permit_count: permitCount,
      national_chain: chain.national_chain ? 'true' : 'false',
      national_chain_reason: chain.reason || '',
      category: 'imported_contractor',
      main_category: 'calling_list_csv',
      maps_url: '',
      in_icp: cell(row, cols.email) || cell(row, cols.phone) ? 'true' : 'false',
      address: cell(row, cols.address),
      source_pipeline: 'permit_parcel_csv',
    });
  }
  return { leads, headers, skipped_empty: skipped, truncated };
}

export async function importCallingListCsv(opts: {
  csv: string;
  name?: string;
  owner?: string;
}): Promise<Record<string, unknown>> {
  if (!hasSupabase()) {
    return { ok: false, error: 'Supabase not configured', ...supabaseTargetMeta() };
  }
  const owner = (opts.owner || 'shared').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'shared';
  const parsed = csvRowsToLeads(opts.csv);
  const jobId = `permit-csv-${randomUUID().slice(0, 8)}`;
  const name =
    opts.name?.trim() || `CSV import · ${parsed.leads.length} rows · ${owner}`;
  const tags = ['permit_parcel', 'calling_list', 'csv_import', `owner:${owner}`];
  const jobErr = await upsertJob({
    id: jobId,
    prompt: name,
    tags,
    requestEstimate: parsed.leads.length,
  });
  if (jobErr) return { ok: false, error: jobErr, ...supabaseTargetMeta() };

  const { deleted, inserted, error } = await replaceLeads(jobId, tags, parsed.leads);
  if (error) return { ok: false, error, ...supabaseTargetMeta() };

  const exportBytes = await upsertExport(jobId, `${jobId}.csv`, opts.csv);
  const metaErr = await upsertCallingListMeta({
    id: jobId,
    name,
    owner,
    source: 'csv_import',
    filters: { import: 'csv', headers: parsed.headers },
    row_count: inserted,
  });
  if (metaErr) {
    return {
      ok: false,
      error: `Leads wrote but calling-list catalog failed: ${metaErr}`,
      list_id: jobId,
      ...supabaseTargetMeta(),
    };
  }
  return {
    ok: true,
    ...supabaseTargetMeta(),
    supabase_schema: SCHEMA,
    list: { id: jobId, name, owner, source: 'csv_import', row_count: inserted },
    rows_inserted: inserted,
    rows_deleted: deleted,
    skipped_empty: parsed.skipped_empty,
    truncated: parsed.truncated,
    max_rows: MAX_CSV_ROWS,
    export_bytes: exportBytes,
    assistant_instructions:
      'CSV is a calling list in Supabase. Tell the user the list id. Filter with query_calling_list. Use this for Houston/Harris or any market not in the DFW cache. Do not dump rows into chat.',
  };
}
