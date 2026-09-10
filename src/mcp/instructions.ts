export const SERVER_INSTRUCTIONS = `
# Permit & Parcel MCP — Claude operating manual

You are connected to **permits-gcs** / Permit & Parcel MCP (SalesGlider; GitHub repo \`permits-GCs\`). Jobs:

1. **Live PermitStack commercial GC pulls for ANY US market** via \`permitstack_pull_calling_list\` (alias \`shovels_pull_calling_list\`) — **not timezone-restricted, not TX-only**
2. **DFW cache** (Dallas / Fort Worth / Rockwall) — free via \`save_calling_list\`
3. **PermitStack request estimates** — 1 HTTP request per search page (100/day on free)
4. **Calling lists in Supabase** — persist pulls so Cayden can filter them for cold calling
5. **Appraisal-district commercial parcels** (Dallas DCAD, Tarrant TAD, Collin CCAD)
6. **Operator rollup** by normalised mailing address (\`build_operators\`) — free

The old Propwire → LoopNet → Google property-owner cascade was **removed**. Do not offer it.

This server is **not** a people-resolver. It surfaces public permit + parcel records. Prefer the name Permit & Parcel over "Property Owners".

## Geography (critical — Cayden)
- Cayden may search **whenever he wants, anywhere in the US**. There is **no timezone gate** and **no Texas-only filter** on live PermitStack tools.
- **Live pull:** \`permitstack_pull\` (alias \`shovels_pull\`) fetches from PermitStack into the same store \`permits_contractors_query\` / \`save_calling_list\` read. Until you pull, that store is Dallas / Fort_Worth / Rockwall_County only — other places return 0 matched, not "no coverage".
- \`max_records\` is required and checked **before** each request. \`dry_run=true\` resolves geos with 0 credits. Cursors persist in \`pull_state.json\` for resume after restart.
- Prefer \`page_size=100\` on trial keys (1 request per page). On record-metered keys, estimate first at size=1.
- **Counties:** pass \`"Hillsborough County, FL"\` / \`"Denton County, TX"\`. Live search uses PermitStack **jurisdiction**, not \`city=Hillsborough\`. A 0-result county is \`county_query_empty\` (loud error), never silent \`no_coverage\`. Prefer a city (Tampa, FL) or ZIPs when the county jurisdiction is empty.
- **ZIPs:** \`"75001;75035;75201"\` resolve as geo_ids. Phone hydration needs \`contractor_id\` on the permit (or a name→id resolve). If every row is \`name:\` only, the tool refuses \`has_phone=true\` instead of writing empty phones.
- **resolve_only=true** on \`shovels_estimate_credits\` maps geos with **0 probe credits**.
- East coast → \`geos=east_coast\`. West coast → \`geos=west_coast\`.
- Flow: resolve_only / dry_run → estimate → \`shovels_pull\` → \`permits_contractors_query(place=…)\`.
- A \`coverage=no_coverage\` after a **city** resolve is a valid answer (thin coverage). A county 0 is \`county_query_empty\`.
- \`permitstack_pull_calling_list\` stores a per-geo **record offset** (not a page index). A second call on the same geo returns **new** contractors even if \`page_size\` changes. Hydration applies to that call's window (after chain/permit filters), paced under 60 req/min. Counters: \`hydrated_ok\` / \`hydrated_rate_limited\` / \`hydrated_failed\` / \`hydrated_skipped_synthetic_id\`. A restart from page 1 always sets \`restart_reason\`. Coverage is \`no_coverage\` / \`exhausted\` / \`empty_page\` / \`county_query_empty\` / \`ok\`.

## Supabase target (critical)
- Every \`health\` and \`sync_to_supabase\` / \`save_calling_list\` response includes \`supabase_project\` + \`supabase_schema\`.
- This MCP writes to project **kemvxzhcxvynmoutwdrh** (schema \`permit_parcel\`, plus \`public.scrape_leads\`). Confirm before diagnosing "table missing".

## Context budget (critical)
- Results write **server-to-server** to Supabase via \`save_calling_list\` / \`shovels_pull_calling_list\` / \`sync_to_supabase\` / \`build_operators\`.
- Tool responses return **counts / small pages** only. Never dump thousands of rows into chat.
- After sync, verify with \`select count(*)\` (or the verify_sql the tool returns).

## When to use
- Any-US live PermitStack commercial contractor / GC list (East/West coast included)
- DFW commercial contractor / GC list (cached ~6,124)
- "How many PermitStack requests would this pull cost?"
- Save a pull so Cayden can filter a cold-calling list later
- Commercial parcel owners from DCAD / TAD / CCAD
- Grouping shell LLCs into real operators by tax-bill mailing address

## When NOT to use
- Google Maps local-business scrapes
- Propwire / LoopNet / residential rolls
- Institutional owners (REIT/fund/trust) — classify and **drop**
- Paid SOS / officer-unmasking lookups
- Smartlead sends / CRM writes

## Owner-type routing
\`owner_type\` on parcels:
- \`individual\` → owner is the decision maker
- \`local_llc\` → use \`build_operators\` + free Texas Comptroller PIR
- \`institutional\` → drop from private-operator outreach
- \`municipal\` → city/county/ISD/housing authority/etc. Different motion; segmentable, not "unknown"

## PermitStack key (do not rotate)
The live PermitStack key is already configured on the server (\`PERMITSTACK_API_KEY\`). **Do not ask Cayden to paste, rotate, or re-set it.** Do not call \`permitstack_set_api_key\` / \`shovels_set_api_key\` unless \`health\` shows \`permitstack_api_configured: false\`. Never echo the full key. Show only a masked fingerprint if asked "is the key set?"

## Owner-cell enrichment (Cayden)
Goal: dial **owner cells**, not office/main/license lines.
1. \`shovels_pull_calling_list\` (any US) or \`save_calling_list\` (DFW cache) or \`import_calling_list_csv\` (only if he already has a file)
2. \`score_calling_list\` (free). Default \`only_unscored=true\` — re-run until \`remaining_unscored=0\`. Limit up to 8,000.
3. \`match_texas_officers(only_unmatched=true, limit=80)\` until \`remaining_unmatched=0\` — Texas entities only. Florida lists: \`match_florida_officers(only_unmatched=true, limit=40)\` (public Sunbiz; optional \`florida_sos_api_key\` if Cloudflare blocks).
4. \`lookup_line_type\` — Veriphone Standard ~$2.40/1k. Show the $ estimate, then \`confirm=true\`. Default limit 50. Re-run \`only_unknown=true\` and **omit offset**. Invalid/non-NANP phones are marked \`invalid\` so the queue drains.
5. \`query_calling_list(dial_status=owner_cell)\` after line type for **match+mobile**. Verified mobiles with no officer source (out-of-state) are \`mobile_unverified_owner\`. Leftovers (\`agent\` / \`different\`): \`owner_people_search\` → Google / FastPeopleSearch / TruePeopleSearch. Take **wireless** only if the address matches. \`record_owner_cell\`
6. Re-query \`query_calling_list(dial_status=owner_cell)\` after recording cells. \`officer_match\` is null until the state officer tool runs — never seeded as \`none\`.

Note: Shovels \`/v2/counties/{geo_id}/metrics/current\` has returned HTTP 500 while \`/metrics/monthly\` stayed healthy. Prefer monthly + contractor search; do not treat current-metrics 500 as a key failure.

Keys: \`set_enrichment_api_key\` for \`veriphone_api_key\`, \`texas_cpa_api_key\`, and optional \`florida_sos_api_key\`. Never echo them.

## PermitStack requests (always estimate when asked)
Call \`permitstack_estimate_credits\` (alias \`shovels_estimate_credits\`, or \`permitstack_pull_calling_list\` without confirm). Quote \`credits.estimated_requests\` — 1 HTTP request per search page. Cached list tools still cost 0. Do not ask anyone to rotate the PermitStack key.

## Workflows

### Contractors (PermitStack) + calling lists
1. If they ask cost → \`permitstack_estimate_credits\` (any geos)
2. **Any US market (incl. East/West coast):** \`permitstack_pull_calling_list\` → show estimate → \`confirm=true\` with \`owner=cayden\`, \`exclude_national_chains=true\`, \`has_phone=true\`
3. **DFW cache only:** \`permits_contractors_*\` then \`save_calling_list\` (0 requests)
4. Later: \`list_calling_lists(owner=cayden)\` → \`query_calling_list(has_phone=true, exclude_national_chains=true)\`
5. CSV import only if Cayden already has a file — do not require CSV for non-DFW

### Parcels
1. \`parcels_summary\`
2. \`parcels_query\` (filter county / owner_name / city / zip / use_code / owner_type)
3. \`sync_to_supabase\` with dataset=parcels
4. \`build_operators\` for mailing-address rollup (counts only)

## Tool cheat sheet
| Tool | Spends PermitStack requests? | Purpose |
|------|------------------------------|---------|
| health | No | Readiness + supabase_project |
| permitstack_estimate_credits | Probe only | Live contractor-search total; any US geo |
| permitstack_pull_calling_list | Yes (confirm) | Live pull any US geo → Supabase calling list |
| permits_contractors_* | No | Cached DFW GCs + any live pulls already written |
| save_calling_list | No | Persist DFW cache pull → Supabase |
| import_calling_list_csv | No | External contractor CSV (optional) |
| list_calling_lists | No | Saved lists by owner/name |
| query_calling_list | No | Filter a saved list (phone/city/dial_status/permit band) |
| score_calling_list | No | Free owner vs office score (resume via only_unscored) |
| match_texas_officers | No | Comptroller PIR officers (TX entities) |
| match_florida_officers | No | Sunbiz officers (FL entities; optional key if Cloudflare blocks) |
| lookup_line_type | ~$2.40/1k | Veriphone mobile vs landline |
| owner_people_search | No | Google / people-search URLs |
| record_owner_cell | No | Save a confirmed wireless |
| parcels_* | No | CAD parcels |
| build_operators | No | Mailing-address operator rollup |
| sync_to_supabase | No | S2S sync; contractor syncs also catalog a calling list |
`.trim();

export const GUIDE_MARKDOWN = `# Permit & Parcel MCP — operator guide

## Identity
- **Name:** Permit & Parcel MCP (not a people "Property Owners" resolver)
- **Server:** \`permits-gcs\`
- **Jobs:** Live PermitStack pulls for any US market + free DFW cache + request estimates + Supabase calling lists + DCAD/TAD/CCAD parcels + mailing-address operators
- **Supabase:** project reported in \`health\` / sync responses (expect \`kemvxzhcxvynmoutwdrh\` / schema \`permit_parcel\`)
- **Removed:** Propwire / LoopNet / Google owner cascade
- **Geography:** No timezone / TX-only restriction on live PermitStack search

## PermitStack key
Already on the server. Do not ask Cayden to rotate it.

## PermitStack requests + live pull
Estimate with \`permitstack_estimate_credits\` (any geos). Pull with \`permitstack_pull_calling_list\` — first call without confirm shows cost; \`confirm=true\` spends and writes the list. Aliases: \`east_coast\`, \`west_coast\`, city/\`City, ST\`, state codes. \`shovels_*\` tool names still work.

## Calling lists (Cayden)
\`permitstack_pull_calling_list\` for any US market. \`save_calling_list\` for the DFW cache. \`import_calling_list_csv\` only when he already has a CSV. Filter with \`list_calling_lists\` / \`query_calling_list\`. Prefer \`has_phone=true\` and \`exclude_national_chains=true\`. Do not drop low-permit locals.

## Sync rules
- No silent 50k truncation — full matching set, or fail loudly
- Upsert parcels on \`(county, account_id)\`
- If scrape \`rows_inserted > 0\` but \`permit_parcel_schema_upserted = 0\`, treat as error
- Always prefer sync/save + SQL \`select count(*)\` over dumping rows into chat

## Operators
\`build_operators\` groups by normalised mailing address (strip C/O, ATTN, %, CARE OF). Excludes out-of-state (spelled + 2-letter codes), tax departments, and municipal owners by default.

## Free PIR path
Do not buy paid SOS unmasking for bulk LLCs. Use Texas Comptroller Public Information Reports after operator rollup (Texas entities) or \`match_florida_officers\` for Florida Sunbiz public records. Registered agent ≠ owner.
`;

export const WHEN_TO_USE_MARKDOWN = `# When to use Permit & Parcel MCP

## Yes
- Live PermitStack commercial GC lists for **any US market** (East/West coast, city, county, state)
- Cached DFW commercial contractor contacts (~6,124)
- Estimate PermitStack request cost for a filter
- Save / filter cold-calling lists in Supabase (Cayden or anyone)
- Commercial parcels from Dallas / Tarrant / Collin appraisal districts
- Operator rollup by mailing address (\`build_operators\`)

## No
- Propwire/LoopNet cascade (removed)
- Maps local businesses
- Institutional fund/REIT owners (drop them)
- Bulk row dumps through chat — use shovels_pull_calling_list / save_calling_list / sync_to_supabase
- Refusing non-DFW / coast pulls (that restriction is gone)

## Money
Cached DFW queries + calling-list writes from the file are 0 credits. A live pull costs about **1 credit per API page (size=100)** on free/trial, or **1 credit per company** on paid — confirm which meter the key uses. Always estimate before \`confirm=true\`.
`;
