import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../server/config.js';
import {
  clearAppSetting,
  enrichmentKeysStatus,
  setAppSetting,
} from '../server/lib/appSettings.js';
import {
  clearShovelsApiKey,
  getShovelsKeyStatus,
  setShovelsApiKey,
} from '../server/lib/shovelsKey.js';
import { hasSupabase, SCHEMA } from '../server/lib/supabase.js';
import { supabaseTargetMeta } from '../server/lib/supabaseTarget.js';
import {
  listCallingLists,
  queryCallingList,
  saveCallingList,
} from '../server/services/callingLists.js';
import { importCallingListCsv } from '../server/services/importCallingList.js';
import {
  lookupLineTypes,
  matchTexasOfficers,
  ownerPeopleSearch,
  recordOwnerCell,
  scoreCallingList,
} from '../server/services/enrichCallingList.js';
import { buildOperators } from '../server/services/operators.js';
import {
  loadParcels,
  parcelsSummary,
  parcelsToCsv,
  queryParcels,
  sampleParcels,
} from '../server/services/parcels.js';
import { estimateShovelsCredits } from '../server/services/shovelsCredits.js';
import { pullShovelsCallingList } from '../server/services/pullShovelsCallingList.js';
import { shovelsPull } from '../server/services/shovelsPull.js';
import {
  contractorsToCsv,
  getShovelsContractor,
  loadShovelsContractors,
  queryShovelsContractors,
  sampleShovelsContractors,
  shovelsContractorsSummary,
} from '../server/services/shovelsContractors.js';
import { syncToSupabase } from '../server/services/syncToSupabase.js';
import {
  GUIDE_MARKDOWN,
  SERVER_INSTRUCTIONS,
  WHEN_TO_USE_MARKDOWN,
} from './instructions.js';

function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

const placeFilter = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Geography tag. Cache tools: Dallas | Fort_Worth | Rockwall_County. Live tools (shovels_pull / estimate / shovels_pull_calling_list): any US city, county, state code, or east_coast / west_coast.',
  );

const countyEnum = z.enum(['Dallas', 'Tarrant', 'Collin']).optional();
const ownerTypeEnum = z
  .enum(['individual', 'local_llc', 'institutional', 'municipal', 'unknown'])
  .optional();

const minPermitCount = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Inclusive min Shovels permit_count. Optional — do not use this to drop small local GCs.');
const maxPermitCount = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Inclusive max Shovels permit_count. Optional — do not use this to drop small local GCs.');
const excludeNationalChains = z
  .boolean()
  .optional()
  .describe(
    'true = drop national GCs / public homebuilders / franchise trades (name match or 5,000+ employees). Keeps local shops of any permit volume.',
  );

async function healthPayload() {
  const target = supabaseTargetMeta();
  const shovelsKey = await getShovelsKeyStatus();
  return {
    ok: true,
    product: 'Permit & Parcel MCP',
    demoMode: config.demoMode,
    supabaseConfigured: hasSupabase(),
    supabase_project: target.supabase_project,
    supabase_schema: target.supabase_schema ?? SCHEMA,
    supabase_url: target.supabase_url,
    permitstack_api_configured: shovelsKey.configured,
    shovels_api_configured: shovelsKey.configured,
    permitstack_api_key: shovelsKey,
    shovels_api_key: shovelsKey,
    shovels_contractors_loaded: loadShovelsContractors().length,
    parcels_loaded: loadParcels().length,
    when_to_use:
      'PermitStack commercial GCs (including request estimates); DCAD/TAD/CCAD commercial parcels; mailing-address operator rollup; persist/filter cold-calling lists in Supabase (e.g. Cayden). The PermitStack key is already on the server — do not ask anyone to rotate it.',
    when_not_to_use:
      'Propwire/LoopNet cascade (removed), Maps scrapes, institutional REIT/fund owners, paid SOS unmasking, bulk row dumps in chat.',
    how_to_use:
      'Live: permitstack_pull / shovels_pull into the contractor store (then permits_contractors_query). DFW cache still free via save_calling_list. Enrich: score → match_texas_officers → lookup_line_type → owner_people_search. Never echo API keys.',
    removed:
      'pmf_parse_query, pmf_confirm_run, Propwire → LoopNet → Google owner cascade (broken; not repaired).',
  };
}

export function createPermitParcelMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'permits-gcs',
      version: '2.0.0',
      title: 'Permit & Parcel MCP (permits-GCs)',
      description:
        'USE FOR: (1) Live PermitStack commercial GC pulls for ANY US market via permitstack_pull_calling_list (alias shovels_pull_calling_list); (2) free DFW cache (~6,124); (3) request estimates; (4) Supabase calling lists; (5) DCAD/TAD/CCAD parcels + build_operators. The PermitStack key is already configured — do not ask Cayden to rotate it. DO NOT USE FOR: Propwire/LoopNet, Maps scrapes, paid SOS. Never echo a full API key.',
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerResource(
    'pp_guide',
    'permit-parcel://guide',
    {
      title: 'Permit & Parcel operator guide',
      description: 'Full manual: Shovels GCs, credit estimates, calling lists, parcels, sync rules.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDE_MARKDOWN }],
    }),
  );

  server.registerResource(
    'pp_when_to_use',
    'permit-parcel://when-to-use',
    {
      title: 'When to use Permit & Parcel (quick)',
      description: 'Yes/no decision + money/context gates.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: WHEN_TO_USE_MARKDOWN }],
    }),
  );

  server.registerTool(
    'health',
    {
      title: 'Health check',
      description:
        'Readiness: Supabase, loaded contractor + parcel counts. Call first.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => jsonResult(await healthPayload()),
  );

  // ---- Shovels / permits contractors (behavior unchanged; prefix renamed) ----

  server.registerTool(
    'permits_contractors_summary',
    {
      title: 'Shovels commercial contractors — summary',
      description: `WHEN TO USE: Counts for the ~6,124 Shovels commercial GC file (Dallas / Fort Worth / Rockwall).
WHAT IT DOES: Summary counts + fill rates. Free. Local cache.
RULE: Never dump all rows into chat; use query/sample/sync.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => jsonResult(shovelsContractorsSummary()),
  );

  server.registerTool(
    'permits_contractors_query',
    {
      title: 'Shovels commercial contractors — paginated query',
      description: `Search/filter cached Shovels GC contacts. Max 50/page. Free. Prefer exclude_national_chains=true. Do not drop low-permit locals.`,
      inputSchema: {
        q: z.string().optional(),
        place: placeFilter,
        city: z.string().optional(),
        state: z.string().optional(),
        has_email: z.boolean().optional(),
        has_phone: z.boolean().optional(),
        has_website: z.boolean().optional(),
        min_permit_count: minPermitCount,
        max_permit_count: maxPermitCount,
        exclude_national_chains: excludeNationalChains,
        page: z.number().int().min(1).optional(),
        page_size: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => jsonResult(queryShovelsContractors(args)),
  );

  server.registerTool(
    'permits_contractors_sample',
    {
      title: 'Shovels commercial contractors — random sample',
      description: `≤20 random Shovels GC rows for QA. Free. Prefer exclude_national_chains=true.`,
      inputSchema: {
        n: z.number().int().min(1).max(20).optional(),
        q: z.string().optional(),
        place: placeFilter,
        city: z.string().optional(),
        state: z.string().optional(),
        has_email: z.boolean().optional(),
        has_phone: z.boolean().optional(),
        has_website: z.boolean().optional(),
        min_permit_count: minPermitCount,
        max_permit_count: maxPermitCount,
        exclude_national_chains: excludeNationalChains,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      jsonResult(
        sampleShovelsContractors(args.n ?? 20, {
          q: args.q,
          place: args.place,
          city: args.city,
          state: args.state,
          has_email: args.has_email,
          has_phone: args.has_phone,
          has_website: args.has_website,
          min_permit_count: args.min_permit_count,
          max_permit_count: args.max_permit_count,
          exclude_national_chains: args.exclude_national_chains,
        }),
      ),
  );

  server.registerTool(
    'permits_contractors_get',
    {
      title: 'Shovels commercial contractor — get by id',
      description: `One cached contractor by Shovels id. Free.`,
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const row = getShovelsContractor(id);
      if (!row) return errorResult(`Contractor not found: ${id}`);
      return jsonResult(row);
    },
  );

  server.registerTool(
    'permits_contractors_export_csv',
    {
      title: 'Shovels commercial contractors — filtered CSV',
      description: `CSV for matching Shovels GCs, cap 5000. Prefer sync_to_supabase for bulk. Supports permit-count range.`,
      inputSchema: {
        q: z.string().optional(),
        place: placeFilter,
        city: z.string().optional(),
        state: z.string().optional(),
        has_email: z.boolean().optional(),
        has_phone: z.boolean().optional(),
        has_website: z.boolean().optional(),
        min_permit_count: minPermitCount,
        max_permit_count: maxPermitCount,
        exclude_national_chains: excludeNationalChains,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const items = [];
      let page = 1;
      for (;;) {
        const batch = queryShovelsContractors({ ...args, page, page_size: 50 });
        items.push(...batch.items);
        if (page >= batch.total_pages || items.length >= 5000) break;
        page += 1;
      }
      const capped = items.slice(0, 5000);
      return jsonResult({
        total_matching: capped.length,
        capped_at: 5000,
        csv: contractorsToCsv(capped),
        hint: 'For bulk persistence use sync_to_supabase(dataset=contractors).',
      });
    },
  );

  // ---- Parcels ----

  server.registerTool(
    'parcels_summary',
    {
      title: 'Appraisal parcels — summary',
      description: `Counts for DCAD/TAD/CCAD commercial parcels by county and owner_type. Free.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => jsonResult(parcelsSummary()),
  );

  server.registerTool(
    'parcels_query',
    {
      title: 'Appraisal parcels — paginated query',
      description: `WHEN TO USE: Search commercial parcels (county, owner_name, city, zip, use_code, owner_type).
WHAT IT DOES: Returns one page (max 50) + totals. Free. Local CAD extracts.
NEXT: sync_to_supabase(dataset=parcels) for full matching set.`,
      inputSchema: {
        county: countyEnum,
        owner_name: z.string().optional(),
        city: z.string().optional(),
        zip: z.string().optional(),
        use_code: z.string().optional(),
        owner_type: ownerTypeEnum,
        min_assessed_value: z.number().optional(),
        q: z.string().optional(),
        page: z.number().int().min(1).optional(),
        page_size: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => jsonResult(queryParcels(args)),
  );

  server.registerTool(
    'parcels_sample',
    {
      title: 'Appraisal parcels — random sample',
      description: `≤20 random matching parcels for QA. Free.`,
      inputSchema: {
        n: z.number().int().min(1).max(20).optional(),
        county: countyEnum,
        owner_name: z.string().optional(),
        city: z.string().optional(),
        zip: z.string().optional(),
        use_code: z.string().optional(),
        owner_type: ownerTypeEnum,
        q: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => jsonResult(sampleParcels(args.n ?? 20, args)),
  );

  server.registerTool(
    'parcels_export_csv',
    {
      title: 'Appraisal parcels — filtered CSV',
      description: `CSV for matching parcels, cap 5000. Prefer sync_to_supabase for bulk persistence.`,
      inputSchema: {
        county: countyEnum,
        owner_name: z.string().optional(),
        city: z.string().optional(),
        zip: z.string().optional(),
        use_code: z.string().optional(),
        owner_type: ownerTypeEnum,
        min_assessed_value: z.number().optional(),
        q: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const items = [];
      let page = 1;
      for (;;) {
        const batch = queryParcels({ ...args, page, page_size: 50 });
        items.push(...batch.items);
        if (page >= batch.total_pages || items.length >= 5000) break;
        page += 1;
      }
      const capped = items.slice(0, 5000);
      return jsonResult({
        total_matching: capped.length,
        capped_at: 5000,
        csv: parcelsToCsv(capped),
        hint: 'For bulk persistence use sync_to_supabase(dataset=parcels).',
      });
    },
  );

  // ---- Shovels API key (Cayden can change from Claude) ----

  server.registerTool(
    'shovels_api_key_status',
    {
      title: 'PermitStack API key — status (masked)',
      description: `WHEN TO USE: Cayden asks whether a PermitStack key is set. Alias: permitstack_api_key_status.
WHAT IT DOES: Returns configured/source/masked fingerprint only. Never the full key. Free.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => jsonResult(await getShovelsKeyStatus()),
  );

  server.registerTool(
    'shovels_set_api_key',
    {
      title: 'PermitStack API key — set from Claude',
      description: `WHEN TO USE: Cayden wants to paste/change the PermitStack API key from Claude. Alias: permitstack_set_api_key.
WHAT IT DOES: Stores the key in memory and persists it to Supabase so Railway restarts keep it.
RULES: confirm must be true. Never repeat the full key in chat — only the masked fingerprint. Default set_by=cayden.`,
      inputSchema: {
        api_key: z.string().min(1).describe('The PermitStack API key. Do not echo this back in chat.'),
        confirm: z
          .boolean()
          .describe('Must be true. Show Cayden you are about to replace the live PermitStack key, then set true.'),
        set_by: z.string().optional().describe('Who is changing it. Default cayden.'),
        persist: z
          .boolean()
          .optional()
          .describe('Save to Supabase so it survives restarts. Default true.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async (args) => {
      if (args.confirm !== true) {
        return errorResult(
          'Set confirm=true after Cayden agrees to replace the live PermitStack API key. Do not echo the key.',
        );
      }
      try {
        return jsonResult(
          await setShovelsApiKey({
            api_key: args.api_key,
            set_by: args.set_by,
            persist: args.persist,
          }),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'shovels_set_api_key failed');
      }
    },
  );

  server.registerTool(
    'shovels_clear_api_key',
    {
      title: 'PermitStack API key — clear Claude override',
      description: `WHEN TO USE: Cayden wants to drop the Claude-set key and fall back to PERMITSTACK_API_KEY env (or unset). Alias: permitstack_clear_api_key.
RULES: confirm must be true. Never echo any key.`,
      inputSchema: {
        confirm: z.boolean().describe('Must be true'),
        set_by: z.string().optional().describe('Default cayden'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async (args) => {
      if (args.confirm !== true) {
        return errorResult('Set confirm=true to clear the Claude-set PermitStack API key.');
      }
      try {
        return jsonResult(await clearShovelsApiKey({ set_by: args.set_by }));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'shovels_clear_api_key failed');
      }
    },
  );

  server.registerTool(
    'permitstack_api_key_status',
    {
      title: 'PermitStack API key — status (masked)',
      description: 'Masked fingerprint of the live PermitStack key. Never the full key.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => jsonResult(await getShovelsKeyStatus()),
  );

  server.registerTool(
    'permitstack_set_api_key',
    {
      title: 'PermitStack API key — set from Claude',
      description: 'Same as shovels_set_api_key. confirm=true. Never echo the full key.',
      inputSchema: {
        api_key: z.string().min(1).describe('The PermitStack API key. Do not echo this back in chat.'),
        confirm: z.boolean().describe('Must be true'),
        set_by: z.string().optional(),
        persist: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async (args) => {
      if (args.confirm !== true) {
        return errorResult('Set confirm=true after Cayden agrees to replace the live PermitStack API key.');
      }
      try {
        return jsonResult(
          await setShovelsApiKey({
            api_key: args.api_key,
            set_by: args.set_by,
            persist: args.persist,
          }),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'permitstack_set_api_key failed');
      }
    },
  );

  server.registerTool(
    'permitstack_clear_api_key',
    {
      title: 'PermitStack API key — clear Claude override',
      description: 'Same as shovels_clear_api_key. confirm=true.',
      inputSchema: {
        confirm: z.boolean().describe('Must be true'),
        set_by: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async (args) => {
      if (args.confirm !== true) {
        return errorResult('Set confirm=true to clear the Claude-set PermitStack API key.');
      }
      try {
        return jsonResult(await clearShovelsApiKey({ set_by: args.set_by }));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'permitstack_clear_api_key failed');
      }
    },
  );

  // ---- PermitStack request estimate + calling lists (shovels_* names are aliases) ----

  server.registerTool(
    'shovels_estimate_credits',
    {
      title: 'Estimate PermitStack API requests',
      description: `WHEN TO USE: Request estimate OR geo resolution check for any US market. Alias: permitstack_estimate_credits.
WHAT IT DOES: Resolves geos locally (no live geo index). Then probes GET /v1/contractors/search (city+state; county uses the county name as city). 1 request per probe. Returns estimated_requests = ceil(total / page_size). resolve_only=true spends 0.
RULES: Prefer "Denton County, TX; Collin County, TX". PermitStack bills per HTTP request (100/day free), not per contractor record.
NEXT: Show resolution table. Then pull with permitstack_pull / shovels_pull_calling_list.`,
      inputSchema: {
        geos: z
          .string()
          .optional()
          .describe('Prefer semicolons: "Denton County, TX; Collin County, TX" or ZIPs "75001;75035". Also east_coast/west_coast aliases.'),
        place: placeFilter,
        city: z.string().optional(),
        geo_level: z
          .enum(['auto', 'city', 'county', 'zip', 'state'])
          .optional()
          .describe('Force level for every token. Use county for outer-ring DFW lists.'),
        resolve_only: z
          .boolean()
          .optional()
          .describe('true = resolve geos only, spend 0 probe credits'),
        date_from: z.string().optional().describe('YYYY-MM-DD, default last 12 months'),
        date_to: z.string().optional().describe('YYYY-MM-DD'),
        property_type: z.string().optional().describe("Default 'commercial'"),
        page_size: z.number().int().min(1).max(100).optional().describe('Default 100 (last DFW job)'),
        max_records: z.number().int().min(1).optional(),
        q: z.string().optional(),
        state: z.string().optional().describe('Default state disambiguator, e.g. TX'),
        has_email: z.boolean().optional(),
        has_phone: z.boolean().optional(),
        has_website: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => jsonResult(await estimateShovelsCredits(args)),
  );

  server.registerTool(
    'permitstack_estimate_credits',
    {
      title: 'Estimate PermitStack API requests',
      description: 'Same as shovels_estimate_credits. Probe GET /v1/contractors/search; 1 request per geo.',
      inputSchema: {
        geos: z.string().optional(),
        place: placeFilter,
        city: z.string().optional(),
        geo_level: z.enum(['auto', 'city', 'county', 'zip', 'state']).optional(),
        resolve_only: z.boolean().optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        property_type: z.string().optional(),
        page_size: z.number().int().min(1).max(100).optional(),
        max_records: z.number().int().min(1).optional(),
        q: z.string().optional(),
        state: z.string().optional(),
        has_email: z.boolean().optional(),
        has_phone: z.boolean().optional(),
        has_website: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => jsonResult(await estimateShovelsCredits(args)),
  );

  server.registerTool(
    'shovels_pull',
    {
      title: 'Live PermitStack pull → local contractor store',
      description: `WHEN TO USE: Fetch live PermitStack contractors for a geo (e.g. Denton County) into the same store permits_contractors_query / save_calling_list read. Alias: permitstack_pull.
WHAT IT DOES: Resolves geos locally, pages GET /v1/contractors/search (city+state), upserts by contractor id, returns COUNTS only. dry_run=true resolves only (0 requests).
RULES: max_records required. 1 request per page (per_page up to 100). Never dump rows.
NEXT: permits_contractors_query(place="Denton_County") / save_calling_list.`,
      inputSchema: {
        geos: z
          .string()
          .optional()
          .describe('Prefer "Denton County, TX; Collin County, TX" (comma before state).'),
        place: placeFilter,
        city: z.string().optional(),
        state: z.string().optional(),
        geo_level: z.enum(['auto', 'city', 'county', 'zip', 'state']).optional(),
        property_type: z.string().optional().describe("Default 'commercial'"),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        page_size: z.number().int().min(1).max(100).optional().describe('Default 100'),
        max_records: z
          .number()
          .int()
          .min(1)
          .max(50000)
          .describe('Hard ceiling — required. Checked before each API request.'),
        dry_run: z.boolean().optional().describe('true = resolve only, 0 credits'),
        min_credits_remaining: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Abort if remaining drops below this (default 5)'),
        reset_cursor: z.boolean().optional().describe('Ignore saved cursors and start fresh'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await shovelsPull(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'shovels_pull failed');
      }
    },
  );

  server.registerTool(
    'permitstack_pull',
    {
      title: 'Live PermitStack pull → local contractor store',
      description: 'Same as shovels_pull. Pages GET /v1/contractors/search by city/state.',
      inputSchema: {
        geos: z.string().optional(),
        place: placeFilter,
        city: z.string().optional(),
        state: z.string().optional(),
        geo_level: z.enum(['auto', 'city', 'county', 'zip', 'state']).optional(),
        property_type: z.string().optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        page_size: z.number().int().min(1).max(100).optional(),
        max_records: z.number().int().min(1).max(50000),
        dry_run: z.boolean().optional(),
        min_credits_remaining: z.number().int().min(0).optional(),
        reset_cursor: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await shovelsPull(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'permitstack_pull failed');
      }
    },
  );

  server.registerTool(
    'shovels_pull_calling_list',
    {
      title: 'Live PermitStack pull → Supabase calling list (any US geo)',
      description: `WHEN TO USE: Cayden wants a GC calling list for ANY US market. Alias: permitstack_pull_calling_list.
WHAT IT DOES: Without confirm=true, returns a request estimate only. With confirm=true, pages PermitStack /v1/contractors/search (cities) or /v1/permits/search (county jurisdiction / ZIP), writes scrape_leads + calling_lists. has_phone=true hydrates THIS window's profiles (paced under 60 req/min; 429s retry). Chain/permit filters run before hydration.
RULES: Prefer exclude_national_chains=true and has_phone=true for dialable locals. Default max_records=1500 (cap 8000). Re-run the same geo to resume the stored cursor (new contractors). Pass cursor/offset/reset_cursor to control paging. east_coast / west_coast expand to major metros.
NEXT: list_calling_lists / query_calling_list / score_calling_list.`,
      inputSchema: {
        geos: z
          .string()
          .optional()
          .describe('Prefer "Denton County, TX; Collin County, TX" or ZIPs. east_coast/west_coast ok.'),
        place: placeFilter,
        city: z.string().optional(),
        state: z.string().optional().describe('Optional 2-letter state disambiguator'),
        geo_level: z.enum(['auto', 'city', 'county', 'zip', 'state']).optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        property_type: z.string().optional().describe("Default 'commercial'"),
        page_size: z.number().int().min(1).max(100).optional(),
        max_records: z.number().int().min(1).max(8000).optional().describe('Default 1500'),
        has_phone: z.boolean().optional(),
        has_email: z.boolean().optional(),
        exclude_national_chains: excludeNationalChains,
        min_permit_count: minPermitCount,
        max_permit_count: maxPermitCount,
        name: z.string().optional().describe('Human list name'),
        owner: z.string().optional().describe('Default cayden'),
        confirm: z
          .boolean()
          .optional()
          .describe('Must be true to spend Shovels credits and write the list'),
        cursor: z.string().optional().describe('PermitStack page to resume from (overrides stored cursor)'),
        offset: z.number().int().min(0).optional().describe('Skip first N contractors in fetch order'),
        reset_cursor: z.boolean().optional().describe('Clear stored cursor and start at page 1'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await pullShovelsCallingList(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'shovels_pull_calling_list failed');
      }
    },
  );

  server.registerTool(
    'permitstack_pull_calling_list',
    {
      title: 'Live PermitStack pull → Supabase calling list',
      description: 'Same as shovels_pull_calling_list. confirm=true spends requests and writes the list.',
      inputSchema: {
        geos: z.string().optional(),
        place: placeFilter,
        city: z.string().optional(),
        state: z.string().optional(),
        geo_level: z.enum(['auto', 'city', 'county', 'zip', 'state']).optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        property_type: z.string().optional(),
        page_size: z.number().int().min(1).max(100).optional(),
        max_records: z.number().int().min(1).max(8000).optional(),
        has_phone: z.boolean().optional(),
        has_email: z.boolean().optional(),
        exclude_national_chains: z.boolean().optional(),
        min_permit_count: z.number().int().min(0).optional(),
        max_permit_count: z.number().int().min(0).optional(),
        name: z.string().optional(),
        owner: z.string().optional(),
        confirm: z.boolean().optional(),
        cursor: z.string().optional(),
        offset: z.number().int().min(0).optional(),
        reset_cursor: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await pullShovelsCallingList(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'permitstack_pull_calling_list failed');
      }
    },
  );

  server.registerTool(
    'save_calling_list',
    {
      title: 'Save contractor pull to Supabase calling list',
      description: `WHEN TO USE: Persist a filtered DFW cache pull (Dallas/Fort Worth/Rockwall file) — free, 0 credits.
For East/West coast or any non-DFW market use shovels_pull_calling_list instead.
WHAT IT DOES: Writes matching contractors from the local cache to Supabase calling_lists. Returns counts + list id only.
QUALIFY: exclude_national_chains=true. Do not drop low-permit locals.`,
      inputSchema: {
        name: z.string().optional().describe('Human list name, e.g. "Cayden Fort Worth GCs with phone"'),
        owner: z
          .string()
          .optional()
          .describe('Who the list is for, e.g. "cayden". Used as the filter key later.'),
        q: z.string().optional(),
        place: placeFilter,
        city: z.string().optional(),
        state: z.string().optional(),
        has_email: z.boolean().optional(),
        has_phone: z.boolean().optional(),
        has_website: z.boolean().optional(),
        min_permit_count: minPermitCount,
        max_permit_count: maxPermitCount,
        exclude_national_chains: excludeNationalChains,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        return jsonResult(
          await saveCallingList({
            name: args.name,
            owner: args.owner,
            contractor_query: {
              q: args.q,
              place: args.place,
              city: args.city,
              state: args.state,
              has_email: args.has_email,
              has_phone: args.has_phone,
              has_website: args.has_website,
              min_permit_count: args.min_permit_count,
              max_permit_count: args.max_permit_count,
              exclude_national_chains: args.exclude_national_chains,
            },
          }),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'save_calling_list failed');
      }
    },
  );

  server.registerTool(
    'import_calling_list_csv',
    {
      title: 'Import an external CSV as a calling list',
      description: `WHEN TO USE: Cayden already has a contractor CSV. Prefer shovels_pull_calling_list for live East/West coast / any-US pulls.
WHAT IT DOES: Parses CSV (company/contact/phone/email/city/state/zip), writes scrape_leads + calling_lists. Cap 8,000 rows. 0 Shovels credits.
NEXT: Return list id. Then score_calling_list / query_calling_list. Do not dump rows into chat.`,
      inputSchema: {
        csv: z.string().min(10).describe('Full CSV text including header row'),
        name: z.string().optional().describe('Human list name, e.g. "Cayden Harris GCs"'),
        owner: z.string().optional().describe('Who the list is for, e.g. cayden'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await importCallingListCsv(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'import_calling_list_csv failed');
      }
    },
  );

  server.registerTool(
    'list_calling_lists',
    {
      title: 'List saved cold-calling lists',
      description: `WHEN TO USE: Cayden (or anyone) asks what calling lists exist, or needs a list_id.
WHAT IT DOES: Reads permit_parcel.calling_lists from Supabase. Filter by owner (e.g. cayden). Counts only + metadata. Free.`,
      inputSchema: {
        owner: z.string().optional().describe('e.g. cayden'),
        q: z.string().optional().describe('Search list name / owner / id'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await listCallingLists(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'list_calling_lists failed');
      }
    },
  );

  server.registerTool(
    'query_calling_list',
    {
      title: 'Filter a saved calling list (cold calling)',
      description: `WHEN TO USE: Cayden wants dialable contacts from a saved list (has phone, city, name search).
WHAT IT DOES: Pages rows from the Supabase-backed list (max 50/page). Free. Does not re-pull Shovels.
QUALIFY: exclude_national_chains=true. Do not drop low-permit locals.
RULE: Paginate. Summarize fill (phone/email). Do not dump the whole list into chat.`,
      inputSchema: {
        list_id: z.string().optional().describe('Calling list / scrape job id from save_calling_list'),
        owner: z.string().optional().describe('e.g. cayden — all of that owner\'s lists'),
        q: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        has_phone: z.boolean().optional().describe('true = dialable rows only'),
        has_email: z.boolean().optional(),
        dial_status: z
          .enum([
            'owner_cell',
            'owner_landline',
            'company_line',
            'mobile_unverified_owner',
            'needs_enrichment',
            'skip',
          ])
          .optional()
          .describe('After enrichment. owner_cell = officer-confirmed mobile; mobile_unverified_owner = verified mobile, no officer source'),
        min_permit_count: minPermitCount,
        max_permit_count: maxPermitCount,
        exclude_national_chains: excludeNationalChains,
        page: z.number().int().min(1).optional(),
        page_size: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await queryCallingList(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'query_calling_list failed');
      }
    },
  );

  server.registerTool(
    'enrichment_keys_status',
    {
      title: 'Enrichment API keys — status (masked)',
      description: `WHEN TO USE: Before officer match or line-type lookup. Shows whether Veriphone + Texas Comptroller + Shovels keys are set. Never the full keys.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => jsonResult(await enrichmentKeysStatus()),
  );

  server.registerTool(
    'set_enrichment_api_key',
    {
      title: 'Set Veriphone or Texas Comptroller API key',
      description: `WHEN TO USE: Cayden pastes a Veriphone or Texas CPA API key from Claude.
RULES: confirm=true. Never echo the full key. key is veriphone_api_key or texas_cpa_api_key (or shovels_api_key).`,
      inputSchema: {
        key: z
          .enum(['veriphone_api_key', 'texas_cpa_api_key', 'shovels_api_key', 'permitstack_api_key'])
          .describe('Which key to set'),
        api_key: z.string().min(1).describe('The secret. Do not echo this back.'),
        confirm: z.boolean().describe('Must be true'),
        set_by: z.string().optional(),
        persist: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async (args) => {
      if (args.confirm !== true) {
        return errorResult('Set confirm=true after Cayden agrees to save the key. Do not echo it.');
      }
      try {
        return jsonResult(
          await setAppSetting({
            key: args.key,
            api_key: args.api_key,
            set_by: args.set_by,
            persist: args.persist,
          }),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'set_enrichment_api_key failed');
      }
    },
  );

  server.registerTool(
    'clear_enrichment_api_key',
    {
      title: 'Clear a Claude-set enrichment API key',
      description: 'Drops the Claude override for Veriphone / Texas CPA / Shovels. confirm=true.',
      inputSchema: {
        key: z.enum(['veriphone_api_key', 'texas_cpa_api_key', 'shovels_api_key', 'permitstack_api_key']),
        confirm: z.boolean(),
        set_by: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async (args) => {
      if (args.confirm !== true) return errorResult('Set confirm=true to clear the key.');
      try {
        return jsonResult(await clearAppSetting({ key: args.key, set_by: args.set_by }));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'clear failed');
      }
    },
  );

  server.registerTool(
    'score_calling_list',
    {
      title: 'Score a calling list (free owner/office guess)',
      description: `WHEN TO USE: After save_calling_list, before any paid lookup.
WHAT IT DOES: Flags owner-likely vs company-line. $0. Default only_unscored=true so repeats walk the rest of a 6k list. Limit up to 8,000. Returns remaining_unscored + has_more.`,
      inputSchema: {
        list_id: z.string().min(1),
        limit: z.number().int().min(1).max(8000).optional(),
        offset: z.number().int().min(0).optional(),
        only_unscored: z
          .boolean()
          .optional()
          .describe('Default true. Re-run to score the next unscored batch.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await scoreCallingList(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'score_calling_list failed');
      }
    },
  );

  server.registerTool(
    'match_texas_officers',
    {
      title: 'Match Texas Comptroller officers (free PIR)',
      description: `WHEN TO USE: Confirm the legal owner/manager name for companies on a calling list.
WHAT IT DOES: Comptroller franchise search. Default limit 80 (HTTP budget ~48s so a full batch can finish). only_unmatched=true skips match/none/different/agent/error/unavailable so re-runs advance — do not use next_offset while that filter is on. Never-attempted is officer_match=null (not none). Out-of-state rows are marked unavailable. Person-style names (ABEL GARCIA) skip partnership substring hits. Sole props with no franchise-tax account are officer_match=none, not error. officer_match=agent means registered agent only (not the owner).`,
      inputSchema: {
        list_id: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional().describe('Default 80. Max 100; one call should finish within the 48s budget.'),
        offset: z.number().int().min(0).optional(),
        only_unmatched: z
          .boolean()
          .optional()
          .describe('Default true. Rows already matched/none/error are skipped.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await matchTexasOfficers(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'match_texas_officers failed');
      }
    },
  );

  server.registerTool(
    'lookup_line_type',
    {
      title: 'Veriphone line type (cell vs landline)',
      description: `WHEN TO USE: After scoring + officers, to mark Shovels phones as mobile/landline/voip.
COST: ~$2.40 per 1,000 (Veriphone Standard). First call without confirm=true returns the $ estimate only.
RULES: Show the estimate. confirm=true to spend. Default cap 50. only_unknown=true (default) resumes — omit offset. Non-NANP phones are marked invalid (no spend) so the queue drains. match+mobile sets dial_status=owner_cell; verified mobile with no officer source sets mobile_unverified_owner. Never echo the API key.`,
      inputSchema: {
        list_id: z.string().min(1),
        confirm: z.boolean().optional().describe('Must be true to spend credits'),
        limit: z.number().int().min(1).max(200).optional().describe('Veriphone lookups per call. Default 50. Invalid phones do not count against this.'),
        offset: z.number().int().min(0).optional().describe('Ignored when only_unknown=true'),
        only_unknown: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await lookupLineTypes(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'lookup_line_type failed');
      }
    },
  );

  server.registerTool(
    'owner_people_search',
    {
      title: 'Google / free people-search URLs for leftover owners',
      description: `WHEN TO USE: Rows still needs_enrichment after officers + line type.
WHAT IT DOES: Builds Google + FastPeopleSearch + TruePeopleSearch URLs from the officer name + city/zip. Does not scrape. Then record_owner_cell.`,
      inputSchema: {
        list_id: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional().describe('Default 25 packs'),
        dial_status: z.string().optional().describe('Default needs_enrichment'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await ownerPeopleSearch(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'owner_people_search failed');
      }
    },
  );

  server.registerTool(
    'record_owner_cell',
    {
      title: 'Save a confirmed owner cell from people search',
      description: `WHEN TO USE: After Cayden or Claude finds a wireless number on FastPeopleSearch/TruePeopleSearch that matches the officer address.
WHAT IT DOES: Sets owner_cell + dial_status=owner_cell. Do not save landlines or relatives.`,
      inputSchema: {
        list_id: z.string().min(1),
        lead_id: z.number().int(),
        phone: z.string().min(7),
        source: z.string().optional().describe('e.g. fastpeoplesearch'),
        line_type: z.enum(['mobile', 'landline', 'voip', 'unknown']).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await recordOwnerCell(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'record_owner_cell failed');
      }
    },
  );

  // ---- Operators (mailing-address rollup) ----

  server.registerTool(
    'build_operators',
    {
      title: 'build_operators — mailing-address operator rollup',
      description: `WHEN TO USE: Collapse shell LLCs into real operators by normalised tax-bill mailing address.
WHAT IT DOES: Groups local CAD parcels by mailing address (strips C/O/ATTN/%); excludes out-of-state, municipal, and tax-department addresses; writes permit_parcel.operators; returns COUNTS only.
DEFAULTS: min_parcels=2, min_llcs=1, exclude_out_of_state/municipal/tax_departments=true, home_states=TX.
PRIME FILTER: min_llcs=3, min_portfolio_value=5000000.
Do not buy paid SOS unmasking for every LLC — resolve operators first; prefer free Texas Comptroller PIR later.`,
      inputSchema: {
        min_parcels: z.number().int().min(1).optional(),
        min_llcs: z.number().int().min(1).optional(),
        min_portfolio_value: z.number().int().min(0).optional(),
        exclude_out_of_state: z.boolean().optional(),
        exclude_municipal: z.boolean().optional(),
        exclude_tax_departments: z.boolean().optional(),
        home_states: z
          .string()
          .optional()
          .describe('Comma-separated home state codes, default TX'),
        target_schema: z.string().optional(),
        target_table: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await buildOperators(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'build_operators failed');
      }
    },
  );

  // ---- Sync ----

  server.registerTool(
    'sync_to_supabase',
    {
      title: 'sync_to_supabase — Maps-style S2S sync (counts only)',
      description: `WHEN TO USE: Persist parcels and/or Shovels contractors to Supabase without loading rows into chat.
WHAT IT DOES: Full matching set (no silent 50k cap). Upserts permit_parcel.parcels on (county, account_id). Honours county. Fails if scrape rows insert but schema upsert is 0. Returns COUNTS + supabase_project + verify_sql only.
NEXT: Run verify_sql select count(*). Confirm supabase_project matches the project you inspect.`,
      inputSchema: {
        dataset: z
          .enum(['parcels', 'contractors', 'all'])
          .describe('Which dataset(s) to sync'),
        county: countyEnum.describe('Optional parcel county filter'),
        owner_type: ownerTypeEnum.describe('Optional parcel owner_type filter'),
        place: placeFilter.describe('Optional Shovels place filter'),
        q: z.string().optional().describe('Optional text filter for the chosen dataset'),
        list_name: z
          .string()
          .optional()
          .describe('When syncing contractors, name the calling list (Cayden will see this)'),
        owner: z
          .string()
          .optional()
          .describe('When syncing contractors, who owns the calling list (e.g. cayden)'),
        min_permit_count: minPermitCount,
        max_permit_count: maxPermitCount,
        exclude_national_chains: excludeNationalChains,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await syncToSupabase({
          dataset: args.dataset,
          list_name: args.list_name,
          owner: args.owner,
          parcel_query: {
            county: args.county,
            owner_type: args.owner_type,
            q: args.dataset === 'contractors' ? undefined : args.q,
          },
          contractor_query: {
            place: args.place,
            q: args.dataset === 'parcels' ? undefined : args.q,
            min_permit_count: args.min_permit_count,
            max_permit_count: args.max_permit_count,
            exclude_national_chains: args.exclude_national_chains,
          },
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'sync failed');
      }
    },
  );

  server.registerPrompt(
    'pp_query_contractors',
    {
      title: 'Query Shovels commercial contractors',
      description: 'Use for the ~6124 DFW commercial GC file.',
      argsSchema: {
        request: z.string().optional(),
      },
    },
    async ({ request }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Permit & Parcel MCP — PermitStack contractors.
Request: "${request || 'Summarize the contractor file'}"
1) Do not ask anyone to rotate the PermitStack key. It is already on the server.
2) Any US market (East/West coast, city, state): permitstack_pull_calling_list — estimate first, then confirm=true.
3) If they ask cost only: permitstack_estimate_credits (quote estimated_requests)
4) DFW cache: permits_contractors_* then save_calling_list (0 requests). Use exclude_national_chains=true.
5) They filter later with list_calling_lists + query_calling_list (has_phone=true for dialing)
6) verify with select count(*) — never dump all rows into chat.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'pp_set_shovels_key',
    {
      title: 'PermitStack key status (do not rotate)',
      description: 'The PermitStack key is already on the server. Do not ask Cayden to paste a new one.',
      argsSchema: {
        request: z.string().optional(),
      },
    },
    async ({ request }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Permit & Parcel MCP — PermitStack key.
Request: "${request || 'Is the PermitStack key set?'}"
1) health or permitstack_api_key_status — show only the masked fingerprint
2) Do NOT ask Cayden to paste or rotate the key. It is already configured.
3) If they want a pull, go to permitstack_estimate_credits / permitstack_pull_calling_list.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'pp_filter_calling_list',
    {
      title: 'Filter a saved cold-calling list',
      description: 'Use when Cayden (or another caller) wants to pull/filter a saved Shovels list.',
      argsSchema: {
        request: z.string().optional(),
      },
    },
    async ({ request }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Permit & Parcel MCP — saved calling lists.
Request: "${request || 'Show Cayden calling lists with phone numbers'}"
1) If they asked Shovels credit cost first, call shovels_estimate_credits
2) list_calling_lists (owner=cayden if named)
3) query_calling_list with has_phone=true and exclude_national_chains=true (paginate ≤50). Do not drop low-permit locals.
4) Never dump the full list into chat. Summarize counts and offer the next page.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'pp_enrich_owner_cells',
    {
      title: 'Enrich a calling list to owner cells',
      description: 'Score, Comptroller officers, Veriphone line type, then people-search leftovers.',
      argsSchema: {
        request: z.string().optional(),
      },
    },
    async ({ request }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Permit & Parcel MCP — owner-cell enrichment.
Request: "${request || 'Get Cayden owner cells on his latest list'}"
1) enrichment_keys_status — if Veriphone or Texas CPA missing, have Cayden paste via set_enrichment_api_key. Never echo keys.
2) list_calling_lists(owner=cayden) then score_calling_list(only_unscored=true) until remaining_unscored=0
3) match_texas_officers(only_unmatched=true, limit=80) until remaining_unmatched=0. Re-run with the same only_unmatched filter (offset is unused). Sole-prop CPA 400s are officer_match=none; other permanent 400s are officer_match=error. officer_match=agent is registered-agent-only (not an owner).
4) lookup_line_type without confirm (show $), then confirm=true; re-run only_unknown until remaining_unknown=0. Omit offset. match+mobile → dial_status=owner_cell.
5) owner_people_search for needs_enrichment. Open people-search URLs. record_owner_cell for wireless + matching address only.
6) query_calling_list(dial_status=owner_cell). Do not dump the list. Non-DFW markets: shovels_pull_calling_list(confirm=true). CSV import only if they already have a file.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'pp_query_parcels',
    {
      title: 'Query appraisal parcels',
      description: 'DCAD/TAD/CCAD commercial parcels + operator rollup.',
      argsSchema: {
        request: z.string().optional(),
      },
    },
    async ({ request }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Permit & Parcel MCP — appraisal parcels.
Request: "${request || 'Summarize commercial parcels'}"
1) parcels_summary
2) parcels_query with filters; note owner_type split
3) Drop institutional. For local_llc, use build_operators + free Texas Comptroller PIR.
4) sync_to_supabase(dataset=parcels) then select count(*)
Propwire cascade is removed — do not offer it.`,
          },
        },
      ],
    }),
  );

  return server;
}

/** @deprecated alias — old Property PM Finder name */
export const createPmFinderMcpServer = createPermitParcelMcpServer;
