import { getSupabase, hasSupabase, ingestSecret } from '../lib/supabase.js';
import { supabaseTargetMeta } from '../lib/supabaseTarget.js';
import {
  computeDialStatus,
  scoreContact,
  type DialStatus,
  type OwnerScore,
} from '../lib/contactScore.js';
import { buildPeopleSearchPack } from '../lib/peopleSearch.js';
import { getShovelsContractor } from './shovelsContractors.js';
import {
  getFranchiseAccount,
  hasTexasCpa,
  pickOwnerOfficer,
  rankFranchiseHits,
  searchFranchiseEntities,
  TexasCpaError,
} from '../lib/texasComptroller.js';
import {
  FloridaSunbizError,
  floridaOfficerGapMs,
  getSunbizEntity,
  hasFloridaSosKey,
  hasFloridaSunbiz,
  isFloridaRowState,
  pickSunbizOwnerOfficer,
  searchSunbizEntities,
} from '../lib/floridaSunbiz.js';
import {
  estimateVeriphoneUsd,
  hasVeriphone,
  lookupVeriphone,
  nanpDigits,
} from '../lib/veriphone.js';
import { loadAppSettings } from '../lib/appSettings.js';

export interface EnrichmentRow {
  list_id: string;
  lead_id: number;
  place_id?: string | null;
  company_name?: string | null;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  owner_score?: OwnerScore | string | null;
  flags?: string[] | null;
  email_kind?: string | null;
  phone_line_type?: string | null;
  phone_carrier?: string | null;
  officer_name?: string | null;
  officer_title?: string | null;
  officer_street?: string | null;
  officer_city?: string | null;
  officer_state?: string | null;
  officer_zip?: string | null;
  officer_match?: string | null;
  taxpayer_id?: string | null;
  owner_search_name?: string | null;
  people_search?: Record<string, unknown> | null;
  owner_cell?: string | null;
  owner_cell_source?: string | null;
  dial_status?: DialStatus | string | null;
  evidence?: string | null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function digits(phone: string): string {
  const d = (phone || '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

function countBy(rows: EnrichmentRow[], key: keyof EnrichmentRow) {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = String(r[key] || 'unknown');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function applyDial(row: EnrichmentRow): EnrichmentRow {
  row.dial_status = computeDialStatus({
    owner_score: row.owner_score || 'needs_enrichment',
    email_kind: row.email_kind || null,
    line_type: row.phone_line_type || null,
    officer_match: row.officer_match || null,
    owner_cell: row.owner_cell || null,
  });
  if (row.dial_status === 'owner_cell' && !row.owner_cell && row.phone) {
    row.owner_cell = row.phone;
    row.owner_cell_source = row.owner_cell_source || 'shovels_mobile';
  }
  return row;
}

export interface FetchContactsOpts {
  limit?: number;
  offset?: number;
  unscoredOnly?: boolean;
  unmatchedOnly?: boolean;
  unknownLineTypeOnly?: boolean;
  leadId?: number;
}

export interface FetchContactsResult {
  rows: EnrichmentRow[];
  total: number;
  offset: number;
  limit: number;
  remaining_unscored: number;
  remaining_unmatched: number;
  remaining_unknown_line_type: number;
}

async function fetchContacts(listId: string, opts: FetchContactsOpts = {}): Promise<FetchContactsResult> {
  if (!hasSupabase()) throw new Error('Supabase not configured');
  const { data, error } = await getSupabase().rpc('fetch_permit_parcel_calling_list_contacts', {
    p_secret: ingestSecret(),
    p_list_id: listId,
    p_limit: opts.limit ?? 500,
    p_offset: opts.offset ?? 0,
    p_unscored_only: opts.unscoredOnly === true,
    p_unmatched_only: opts.unmatchedOnly === true,
    p_unknown_line_type_only: opts.unknownLineTypeOnly === true,
    p_lead_id: opts.leadId ?? null,
  });
  if (error) throw new Error(error.message);
  const payload = data as FetchContactsResult & { ok?: boolean; error?: string };
  if (payload?.error) throw new Error(payload.error);
  return {
    rows: (payload?.rows ?? []) as EnrichmentRow[],
    total: Number(payload?.total ?? 0),
    offset: Number(payload?.offset ?? opts.offset ?? 0),
    limit: Number(payload?.limit ?? opts.limit ?? 0),
    remaining_unscored: Number(payload?.remaining_unscored ?? 0),
    remaining_unmatched: Number(payload?.remaining_unmatched ?? 0),
    remaining_unknown_line_type: Number(payload?.remaining_unknown_line_type ?? 0),
  };
}

function isTexasRow(row: EnrichmentRow): boolean {
  const st = String(row.state || '').trim().toUpperCase();
  return st === 'TX' || st === 'TEXAS';
}

function isFloridaRow(row: EnrichmentRow): boolean {
  return isFloridaRowState(row.state);
}

function isPendingFloridaOfficer(row: EnrichmentRow): boolean {
  if (!isFloridaRow(row)) return false;
  if (row.officer_match == null || row.officer_match === '') return true;
  // Texas already stamped FL rows unavailable; retry them here.
  return row.officer_match === 'unavailable';
}

async function persistRows(
  rows: EnrichmentRow[],
  opts: { writeOfficerMatch?: boolean } = {},
): Promise<string | null> {
  if (!rows.length) return null;
  const writeOfficer = opts.writeOfficerMatch === true;
  const { error } = await getSupabase().rpc('upsert_permit_parcel_enrichment', {
    p_secret: ingestSecret(),
    p_rows: rows.map((r) => {
      const payload: Record<string, unknown> = {
        list_id: r.list_id,
        lead_id: r.lead_id,
        place_id: r.place_id ?? null,
        company_name: r.company_name ?? null,
        contact_name: r.contact_name ?? null,
        phone: r.phone ?? null,
        email: r.email ?? null,
        owner_score: r.owner_score ?? null,
        flags: Array.isArray(r.flags) ? r.flags : [],
        email_kind: r.email_kind ?? null,
        phone_line_type: r.phone_line_type ?? null,
        phone_carrier: r.phone_carrier ?? null,
        officer_name: r.officer_name ?? null,
        officer_title: r.officer_title ?? null,
        officer_street: r.officer_street ?? null,
        officer_city: r.officer_city ?? null,
        officer_state: r.officer_state ?? null,
        officer_zip: r.officer_zip ?? null,
        taxpayer_id: r.taxpayer_id ?? null,
        owner_search_name: r.owner_search_name ?? null,
        people_search: r.people_search ?? null,
        owner_cell: r.owner_cell ?? null,
        owner_cell_source: r.owner_cell_source ?? null,
        dial_status: r.dial_status ?? 'needs_enrichment',
        evidence: r.evidence ?? null,
      };
      // Never-attempted stays SQL NULL. Score must not seed officer_match='none'.
      if (writeOfficer || (r.officer_match != null && r.officer_match !== '')) {
        payload.officer_match = r.officer_match;
      }
      return payload;
    }),
  });
  return error ? error.message : null;
}

function sample(rows: EnrichmentRow[], n = 8) {
  return rows.slice(0, n).map((r) => ({
    lead_id: r.lead_id,
    company_name: r.company_name,
    contact_name: r.contact_name,
    owner_score: r.owner_score,
    officer_name: r.officer_name,
    officer_match: r.officer_match,
    phone_line_type: r.phone_line_type,
    dial_status: r.dial_status,
    evidence: r.evidence,
  }));
}

export async function scoreCallingList(opts: {
  list_id: string;
  limit?: number;
  offset?: number;
  only_unscored?: boolean;
}): Promise<Record<string, unknown>> {
  const listId = opts.list_id.trim();
  const onlyUnscored = opts.only_unscored !== false;
  const fetched = await fetchContacts(listId, {
    limit: opts.limit ?? 2000,
    offset: opts.offset ?? 0,
    unscoredOnly: onlyUnscored,
  });
  const rows = fetched.rows;
  const phoneCounts = new Map<string, number>();
  for (const r of rows) {
    const d = digits(r.phone || '');
    if (d) phoneCounts.set(d, (phoneCounts.get(d) || 0) + 1);
  }
  const scored = rows.map((r) => {
    const extra = r.place_id?.startsWith('shovels:')
      ? getShovelsContractor(r.place_id.slice('shovels:'.length))
      : null;
    const scoredRow = scoreContact({
      company_name: r.company_name || extra?.business_name || extra?.name || '',
      contact_name: r.contact_name || extra?.name || '',
      email: r.email || extra?.email || extra?.primary_email || '',
      phone: r.phone || extra?.phone || extra?.primary_phone || '',
      city: r.city || extra?.address_city || '',
      phone_share_count: phoneCounts.get(digits(r.phone || '')) || 1,
    });
    return applyDial({
      ...r,
      owner_score: scoredRow.owner_score,
      flags: scoredRow.flags,
      email_kind: scoredRow.email_kind,
      evidence: scoredRow.evidence,
    });
  });
  const persistError = await persistRows(scored, { writeOfficerMatch: false });
  const remaining = onlyUnscored
    ? Math.max(0, fetched.remaining_unscored - scored.length)
    : fetched.remaining_unscored;
  return {
    ok: !persistError,
    error: persistError,
    ...supabaseTargetMeta(),
    scored: scored.length,
    list_total: fetched.total,
    offset: fetched.offset,
    remaining_unscored: remaining,
    has_more: remaining > 0,
    next_offset: onlyUnscored ? null : fetched.offset + scored.length,
    by_owner_score: countBy(scored, 'owner_score'),
    by_dial_status: countBy(scored, 'dial_status'),
    sample: sample(scored),
    assistant_instructions:
      remaining > 0
        ? `Scored ${scored.length}; ${remaining} still unscored. Call score_calling_list again (only_unscored=true) to continue. Do not dump the list.`
        : 'Free score only. Next: match_texas_officers (TX) or match_florida_officers (FL) in batches (only_unmatched=true). Do not dump the list.',
  };
}

/** ~440ms/row historically; 48s fits a 60s HTTP cap with headroom for persist. */
const OFFICER_BUDGET_MS = 48_000;
const OFFICER_DEFAULT_LIMIT = 80;
const OFFICER_ROW_GAP_MS = 20;

function appendEvidence(row: EnrichmentRow, note: string) {
  row.evidence = [row.evidence, note].filter(Boolean).join(' · ');
}

export async function matchTexasOfficers(opts: {
  list_id: string;
  limit?: number;
  offset?: number;
  only_unmatched?: boolean;
}): Promise<Record<string, unknown>> {
  await loadAppSettings();
  if (!hasTexasCpa()) {
    return {
      ok: false,
      error: 'Texas officer source is unavailable.',
    };
  }
  const onlyUnmatched = opts.only_unmatched !== false;
  const limit = opts.limit ?? OFFICER_DEFAULT_LIMIT;
  const fetched = await fetchContacts(opts.list_id.trim(), {
    limit,
    offset: opts.offset ?? 0,
    unmatchedOnly: onlyUnmatched,
  });
  const targets = fetched.rows.filter((r) => Boolean(r.company_name || r.contact_name));
  let matched = 0;
  let different = 0;
  let none = 0;
  let agent = 0;
  let unavailable = 0;
  let errors = 0;
  let timedOut = false;
  const deadline = Date.now() + OFFICER_BUDGET_MS;
  const processed: EnrichmentRow[] = [];

  for (const row of targets) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    if (!isTexasRow(row)) {
      row.officer_match = 'unavailable';
      appendEvidence(row, 'No Texas officer source for this state');
      applyDial(row);
      processed.push(row);
      await persistRows([row], { writeOfficerMatch: true });
      unavailable += 1;
      continue;
    }
    try {
      const hits = await searchFranchiseEntities(row.company_name || '');
      const ranked = rankFranchiseHits(row.company_name || '', hits);
      let resolved = false;
      for (const cand of ranked) {
        try {
          const entity = await getFranchiseAccount(cand.taxpayerId);
          if (!entity) continue;
          const picked = pickOwnerOfficer(row.contact_name || '', entity);
          row.taxpayer_id = entity.taxpayer_id;
          row.officer_match = picked.match;
          if (picked.match === 'agent') {
            // Registered agent ≠ owner. Do not seed people-search with CT Corp.
            row.officer_name = null;
            row.officer_title = picked.officer?.title || 'registered agent';
            appendEvidence(
              row,
              `Registered agent only (${picked.officer?.name || 'unknown'}); not the owner`,
            );
            agent += 1;
          } else {
            row.officer_name = picked.officer?.name ?? null;
            row.officer_title = picked.officer?.title ?? null;
            row.officer_street = picked.officer?.street ?? null;
            row.officer_city = picked.officer?.city ?? row.city ?? null;
            row.officer_state = picked.officer?.state ?? row.state ?? 'TX';
            row.officer_zip = picked.officer?.zip ?? row.zip ?? null;
            if (picked.match === 'match') matched += 1;
            else if (picked.match === 'different') different += 1;
            else none += 1;
          }
          resolved = true;
          break;
        } catch (err) {
          if (err instanceof TexasCpaError && err.notFranchiseTax) continue;
          throw err;
        }
      }
      if (!resolved) {
        row.officer_match = 'none';
        if (ranked.length) {
          appendEvidence(row, 'Texas CPA: no franchise-tax account for this name (sole prop / partnership)');
        }
        none += 1;
      }
      applyDial(row);
      processed.push(row);
      await persistRows([row], { writeOfficerMatch: true });
      await sleep(OFFICER_ROW_GAP_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'officer lookup failed';
      const permanent = err instanceof TexasCpaError ? err.permanent : /Texas CPA \w+ 400\b/.test(msg);
      appendEvidence(row, msg);
      if (permanent) {
        row.officer_match = 'error';
        applyDial(row);
        processed.push(row);
        await persistRows([row], { writeOfficerMatch: true });
      }
      errors += 1;
    }
  }
  const remaining = onlyUnmatched
    ? Math.max(0, fetched.remaining_unmatched - processed.length)
    : fetched.remaining_unmatched;
  return {
    ok: true,
    ...supabaseTargetMeta(),
    processed: processed.length,
    attempted: targets.length,
    matched,
    different,
    none,
    agent,
    errors,
    timed_out: timedOut,
    budget_ms: OFFICER_BUDGET_MS,
    list_total: fetched.total,
    remaining_unmatched: remaining,
    has_more: remaining > 0,
    // only_unmatched filters in SQL; offset stays unused. null avoids "0 while has_more".
    next_offset: onlyUnmatched ? null : fetched.offset + processed.length,
    resume_with: onlyUnmatched ? { only_unmatched: true, limit } : { offset: fetched.offset + processed.length, limit },
    by_officer_match: { match: matched, different, none, agent, unavailable, errors },
    sample: sample(processed),
    assistant_instructions: remaining
      ? `Processed ${processed.length}; ${remaining} still unmatched. Re-run match_texas_officers(only_unmatched=true, limit=${limit}). Do not pass next_offset while only_unmatched=true — the unmatched filter is the pager. Sole-prop / person-name companies with no franchise-tax account are officer_match=none (not error). Out-of-state rows are officer_match=unavailable. Do not dump the list.`
      : 'Officer names are public PIR data. Out-of-state = unavailable (not none). Florida lists: match_florida_officers. Next lookup_line_type — verified mobiles without an officer source become dial_status=mobile_unverified_owner.',
  };
}

const FLORIDA_OFFICER_DEFAULT_LIMIT = 40;

function hasCompanyName(row: EnrichmentRow): boolean {
  return Boolean(row.company_name || row.contact_name);
}

async function fetchFloridaOfficerTargets(opts: {
  list_id: string;
  limit: number;
  offset: number;
  only_unmatched: boolean;
}): Promise<{ fetched: FetchContactsResult; targets: EnrichmentRow[]; remaining: number }> {
  if (opts.only_unmatched) {
    const unmatched = await fetchContacts(opts.list_id, {
      limit: Math.max(opts.limit * 4, 200),
      offset: 0,
      unmatchedOnly: true,
    });
    const pendingNull = unmatched.rows.filter((r) => isPendingFloridaOfficer(r) && hasCompanyName(r));
    let pending = pendingNull;
    if (pending.length < opts.limit) {
      const all = await fetchContacts(opts.list_id, { limit: 8000, offset: 0, unmatchedOnly: false });
      const retry = all.rows.filter((r) => isPendingFloridaOfficer(r) && hasCompanyName(r));
      const seen = new Set(pending.map((r) => r.lead_id));
      pending = [...pending, ...retry.filter((r) => !seen.has(r.lead_id))];
      const remaining = Math.max(0, pending.length - Math.min(opts.limit, pending.length));
      return {
        fetched: all,
        targets: pending.slice(0, opts.limit),
        remaining,
      };
    }
    return {
      fetched: unmatched,
      targets: pending.slice(0, opts.limit),
      remaining: Math.max(0, pending.length - opts.limit),
    };
  }
  const fetched = await fetchContacts(opts.list_id, {
    limit: opts.limit,
    offset: opts.offset,
    unmatchedOnly: false,
  });
  const targets = fetched.rows.filter((r) => isFloridaRow(r) && hasCompanyName(r));
  return { fetched, targets, remaining: fetched.remaining_unmatched };
}

export async function matchFloridaOfficers(opts: {
  list_id: string;
  limit?: number;
  offset?: number;
  only_unmatched?: boolean;
}): Promise<Record<string, unknown>> {
  await loadAppSettings();
  if (!hasFloridaSunbiz()) {
    return { ok: false, error: 'Florida officer source is unavailable.' };
  }
  const onlyUnmatched = opts.only_unmatched !== false;
  const limit = opts.limit ?? (hasFloridaSosKey() ? OFFICER_DEFAULT_LIMIT : FLORIDA_OFFICER_DEFAULT_LIMIT);
  let fetched: FetchContactsResult;
  let targets: EnrichmentRow[];
  let remainingHint: number;
  try {
    const page = await fetchFloridaOfficerTargets({
      list_id: opts.list_id.trim(),
      limit,
      offset: opts.offset ?? 0,
      only_unmatched: onlyUnmatched,
    });
    fetched = page.fetched;
    targets = page.targets;
    remainingHint = page.remaining;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch contacts failed' };
  }
  let matched = 0;
  let different = 0;
  let none = 0;
  let agent = 0;
  let errors = 0;
  let timedOut = false;
  const deadline = Date.now() + OFFICER_BUDGET_MS;
  const processed: EnrichmentRow[] = [];

  for (const row of targets) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    try {
      const hits = await searchSunbizEntities(row.company_name || '');
      let resolved = false;
      for (const cand of hits) {
        const entity = await getSunbizEntity(cand);
        if (!entity) continue;
        const picked = pickSunbizOwnerOfficer(row.contact_name || '', entity);
        row.taxpayer_id = entity.document_number;
        row.officer_match = picked.match;
        if (picked.match === 'agent') {
          row.officer_name = null;
          row.officer_title = picked.officer?.title || 'registered agent';
          appendEvidence(
            row,
            `Florida Sunbiz registered agent only (${picked.officer?.name || 'unknown'}); not the owner`,
          );
          agent += 1;
        } else {
          row.officer_name = picked.officer?.name ?? null;
          row.officer_title = picked.officer?.title ?? null;
          row.officer_street = picked.officer?.street ?? null;
          row.officer_city = picked.officer?.city ?? row.city ?? null;
          row.officer_state = picked.officer?.state ?? row.state ?? 'FL';
          row.officer_zip = picked.officer?.zip ?? row.zip ?? null;
          if (picked.match === 'match') matched += 1;
          else if (picked.match === 'different') different += 1;
          else none += 1;
        }
        resolved = true;
        break;
      }
      if (!resolved) {
        row.officer_match = 'none';
        if (hits.length) {
          appendEvidence(row, 'Florida Sunbiz: no officer roster for this name');
        } else {
          appendEvidence(row, 'Florida Sunbiz: no entity match');
        }
        none += 1;
      }
      applyDial(row);
      processed.push(row);
      await persistRows([row], { writeOfficerMatch: true });
      await sleep(floridaOfficerGapMs());
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'officer lookup failed';
      if (err instanceof FloridaSunbizError && err.blocked && processed.length === 0) {
        return {
          ok: false,
          blocked: true,
          error: msg,
          ...supabaseTargetMeta(),
          processed: 0,
          remaining_unmatched: remainingHint + targets.length,
          assistant_instructions:
            'Florida Sunbiz blocked this host (Cloudflare). Leave rows unmatched. Cayden can paste a free Sunbiz Daily API key with set_enrichment_api_key(key=florida_sos_api_key, confirm=true). sunbizdata.com keys start with sb_. Do not buy bulk SOS. Then re-run match_florida_officers(only_unmatched=true).',
        };
      }
      const permanent = err instanceof FloridaSunbizError ? err.permanent : /Sunbiz \w+ 400\b/.test(msg);
      appendEvidence(row, msg);
      if (permanent) {
        row.officer_match = 'error';
        applyDial(row);
        processed.push(row);
        await persistRows([row], { writeOfficerMatch: true });
      }
      errors += 1;
    }
  }
  const remaining = onlyUnmatched
    ? Math.max(0, remainingHint + (targets.length - processed.length))
    : fetched.remaining_unmatched;
  return {
    ok: true,
    ...supabaseTargetMeta(),
    source: 'florida_sunbiz',
    processed: processed.length,
    attempted: targets.length,
    matched,
    different,
    none,
    agent,
    errors,
    timed_out: timedOut,
    budget_ms: OFFICER_BUDGET_MS,
    list_total: fetched.total,
    remaining_unmatched: remaining,
    has_more: remaining > 0,
    next_offset: onlyUnmatched ? null : fetched.offset + processed.length,
    resume_with: onlyUnmatched ? { only_unmatched: true, limit } : { offset: fetched.offset + processed.length, limit },
    by_officer_match: { match: matched, different, none, agent, errors },
    sample: sample(processed),
    assistant_instructions: remaining
      ? `Processed ${processed.length}; ${remaining} Florida rows still unmatched. Re-run match_florida_officers(only_unmatched=true, limit=${limit}). Do not pass next_offset while only_unmatched=true. officer_match=agent is registered-agent-only (not an owner). Non-Florida rows are skipped (left unmatched for match_texas_officers). Do not dump the list.`
      : 'Florida officer names are public Sunbiz records. Next lookup_line_type — verified mobiles without an officer source become dial_status=mobile_unverified_owner.',
  };
}

const LINE_TYPE_BUDGET_MS = 48_000;
const LINE_TYPE_DEFAULT_LIMIT = 50;

export async function lookupLineTypes(opts: {
  list_id: string;
  confirm?: boolean;
  limit?: number;
  offset?: number;
  only_unknown?: boolean;
}): Promise<Record<string, unknown>> {
  await loadAppSettings();
  const onlyUnknown = opts.only_unknown !== false;
  const want = opts.limit ?? LINE_TYPE_DEFAULT_LIMIT;
  // only_unknown pages by filter; client offset would skip remaining unknown rows.
  const fetchOffset = onlyUnknown ? 0 : (opts.offset ?? 0);
  const fetched = await fetchContacts(opts.list_id.trim(), {
    limit: want,
    offset: fetchOffset,
    unknownLineTypeOnly: onlyUnknown,
  });
  const usable = fetched.rows.filter((r) => Boolean(nanpDigits(r.phone || '')));
  const junk = fetched.rows.filter((r) => !nanpDigits(r.phone || ''));
  const estimate = estimateVeriphoneUsd(
    Math.min(want, fetched.remaining_unknown_line_type || usable.length || want),
  );
  if (opts.confirm !== true) {
    return {
      ok: false,
      needs_confirm: true,
      lookups: usable.length,
      usd: estimate.usd,
      note: estimate.note,
      ...supabaseTargetMeta(),
      fetched: fetched.rows.length,
      usable_phones: usable.length,
      invalid_phones: junk.length,
      remaining_unknown: fetched.remaining_unknown_line_type,
      has_more: fetched.remaining_unknown_line_type > 0,
      next_offset: onlyUnknown ? null : fetchOffset + fetched.rows.length,
      resume_with: { only_unknown: true, confirm: true, limit: want },
      error: `Would look up ${usable.length} numbers (~$${estimate.usd})${
        junk.length ? `; ${junk.length} non-NANP phones in this page will be marked invalid (no Veriphone spend)` : ''
      }. Set confirm=true to spend Veriphone credits.`,
    };
  }
  if (!hasVeriphone()) {
    return {
      ok: false,
      error: 'Veriphone API key is not set. Cayden pastes it with set_enrichment_api_key(key=veriphone_api_key).',
      ...estimate,
    };
  }

  let looked = 0;
  let markedInvalid = 0;
  let errors = 0;
  let timedOut = false;
  let persistError: string | null = null;
  const deadline = Date.now() + LINE_TYPE_BUDGET_MS;
  const processed: EnrichmentRow[] = [];
  let remainingUnknown = fetched.remaining_unknown_line_type;
  let offset = fetchOffset;

  async function save(row: EnrichmentRow) {
    const err = await persistRows([row]);
    if (err) persistError = err;
  }

  async function markInvalid(row: EnrichmentRow, reason: string) {
    row.phone_line_type = 'invalid';
    appendEvidence(row, reason);
    applyDial(row);
    processed.push(row);
    await save(row);
    markedInvalid += 1;
    remainingUnknown = Math.max(0, remainingUnknown - 1);
  }

  let page = fetched.rows;
  let rounds = 0;
  while (looked < want && Date.now() <= deadline && !persistError && rounds < 15) {
    rounds += 1;
    if (!page.length) break;
    for (const row of page) {
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      if (!nanpDigits(row.phone || '')) {
        await markInvalid(row, 'No 10-digit NANP phone; skipped Veriphone');
        continue;
      }
      if (looked >= want) break;
      try {
        const hit = await lookupVeriphone(row.phone || '');
        row.phone_line_type = hit.normalized_type;
        row.phone_carrier = hit.carrier;
        applyDial(row);
        processed.push(row);
        await save(row);
        looked += 1;
        remainingUnknown = Math.max(0, remainingUnknown - 1);
        await sleep(20);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'veriphone failed';
        errors += 1;
        if (/invalid|not valid|not a valid/i.test(msg)) {
          await markInvalid(row, msg);
        } else {
          appendEvidence(row, msg);
        }
      }
    }
    if (timedOut || looked >= want || persistError) break;
    const more = await fetchContacts(opts.list_id.trim(), {
      limit: Math.max(want - looked, 1),
      offset: onlyUnknown ? 0 : offset + page.length,
      unknownLineTypeOnly: onlyUnknown,
    });
    remainingUnknown = more.remaining_unknown_line_type;
    offset = more.offset;
    page = more.rows;
  }
  if (Date.now() > deadline) timedOut = true;

  const remaining = remainingUnknown;
  const noop = looked === 0 && markedInvalid === 0;
  return {
    ok: !persistError && !(noop && remaining > 0),
    error:
      persistError ||
      (noop && remaining > 0
        ? 'Looked up 0 numbers. Re-run lookup_line_type(only_unknown=true, confirm=true) and omit offset — offset skips remaining unknown rows.'
        : undefined),
    ...supabaseTargetMeta(),
    processed: processed.length,
    looked_up: looked,
    marked_invalid: markedInvalid,
    errors,
    timed_out: timedOut,
    budget_ms: LINE_TYPE_BUDGET_MS,
    remaining_unknown: remaining,
    has_more: remaining > 0,
    next_offset: onlyUnknown ? null : offset,
    resume_with: { only_unknown: true, confirm: true, limit: want },
    spent: estimateVeriphoneUsd(looked),
    by_line_type: countBy(processed, 'phone_line_type'),
    by_dial_status: countBy(processed, 'dial_status'),
    sample: sample(processed),
    assistant_instructions:
      remaining > 0
        ? `Looked up ${looked} (${markedInvalid} invalid phones marked, no Veriphone spend). ${remaining} still unknown. Re-run lookup_line_type(only_unknown=true, confirm=true, limit=${want}) — omit offset. match+mobile → owner_cell; verified mobile with no officer source → mobile_unverified_owner. agent/different still need people-search. Do not dump the list.`
        : 'Show line-type counts and $ spent. query_calling_list(dial_status=owner_cell or mobile_unverified_owner). Leftovers (agent/different) go to owner_people_search.',
  };
}

export async function ownerPeopleSearch(opts: {
  list_id: string;
  limit?: number;
  dial_status?: string;
}): Promise<Record<string, unknown>> {
  const fetched = await fetchContacts(opts.list_id.trim(), { limit: 8000 });
  const want = opts.dial_status || 'needs_enrichment';
  const leftovers = fetched.rows
    .filter((r) => (r.dial_status || 'needs_enrichment') === want)
    .slice(0, opts.limit ?? 25);
  const packs = leftovers
    .map((r) => {
      const extra = r.place_id?.startsWith('shovels:')
        ? getShovelsContractor(r.place_id.slice('shovels:'.length))
        : null;
      const searchName =
        r.officer_match === 'agent' ? r.contact_name || '' : r.officer_name || r.contact_name || '';
      const pack = buildPeopleSearchPack({
        name: searchName,
        city: r.officer_city || r.city || extra?.address_city,
        state: r.officer_state || r.state || extra?.address_state || 'TX',
        zip: r.officer_zip || r.zip || extra?.address_zip,
        street: r.officer_street || extra?.address_street,
      });
      if (!pack) return null;
      r.owner_search_name = pack.search_name;
      r.people_search = { ...pack };
      applyDial(r);
      return {
        lead_id: r.lead_id,
        company_name: r.company_name,
        officer_match: r.officer_match,
        ...pack,
      };
    })
    .filter(Boolean);
  await persistRows(leftovers);
  return {
    ok: true,
    ...supabaseTargetMeta(),
    leftover_count: leftovers.length,
    returned: packs.length,
    packs,
    assistant_instructions:
      'Open the FastPeopleSearch/TruePeopleSearch URL. Prefer a hit matching the officer street/city. Take wireless only. Then record_owner_cell. Do not paste every directory row into chat.',
  };
}

export async function recordOwnerCell(opts: {
  list_id: string;
  lead_id: number;
  phone: string;
  source?: string;
  line_type?: string;
}): Promise<Record<string, unknown>> {
  const fetched = await fetchContacts(opts.list_id.trim(), { leadId: opts.lead_id, limit: 1 });
  const row = fetched.rows.find((r) => Number(r.lead_id) === Number(opts.lead_id)) ?? fetched.rows[0];
  if (!row) return { ok: false, error: `Lead ${opts.lead_id} not found on list ${opts.list_id}` };
  row.owner_cell = opts.phone.trim();
  row.owner_cell_source = opts.source || 'people_search';
  if (opts.line_type) row.phone_line_type = opts.line_type;
  else if (!row.phone_line_type) row.phone_line_type = 'mobile';
  applyDial(row);
  const persistError = await persistRows([row]);
  return {
    ok: !persistError,
    error: persistError,
    ...supabaseTargetMeta(),
    lead_id: row.lead_id,
    company_name: row.company_name,
    owner_cell: row.owner_cell,
    dial_status: row.dial_status,
    assistant_instructions: 'Saved. Do not repeat other numbers from the people-search page.',
  };
}
