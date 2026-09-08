# Permit & Parcel MCP (`permits-GCs`)

GitHub: https://github.com/joshuaosborn561-lang/permits-GCs  
(formerly `property-management-scraper` / misnamed “Property Owners”)

SalesGlider MCP for public **permit + parcel** records — not a people-resolver:

1. **PermitStack commercial contractors** — live `GET /v1/contractors/search` plus a cached DFW CSV (~6,124)
2. **PermitStack API key from Claude** — Cayden can set or change it with `permitstack_set_api_key` (alias `shovels_set_api_key`)
3. **PermitStack request estimates** — 1 HTTP request per search page (100/day on the free tier)
4. **Calling lists in Supabase** — persist pulls so Cayden (or anyone) can filter them for cold calling
5. **Appraisal-district commercial parcels** — DCAD / TAD / CCAD bulk extracts
6. **Operator rollup** — group shell LLCs by normalised tax-bill mailing address (`build_operators`)

The Propwire → LoopNet → Google owner cascade was **removed**.

## Supabase target

This service writes to project **`kemvxzhcxvynmoutwdrh`**, schema **`permit_parcel`**, and contractor lists also land in **`public.scrape_leads`**.  
`health` and every `sync_to_supabase` / `save_calling_list` / `build_operators` response include `supabase_project` + `supabase_schema`. The Google Maps Scraper MCP may use a different project — always check before diagnosing missing tables.

## MCP tools

| Tool | Purpose |
|------|---------|
| `health` | Readiness + `supabase_project` + loaded counts |
| `permitstack_api_key_status` / `shovels_api_key_status` | Masked fingerprint of the live PermitStack key |
| `permitstack_set_api_key` / `shovels_set_api_key` | Cayden sets/changes the key from Claude (`confirm=true`) |
| `permitstack_clear_api_key` / `shovels_clear_api_key` | Drop the Claude override and fall back to env |
| `permitstack_estimate_credits` / `shovels_estimate_credits` | How many PermitStack HTTP requests a filter would cost |
| `permitstack_pull` / `shovels_pull` | Live contractor pull into the local store |
| `permitstack_pull_calling_list` / `shovels_pull_calling_list` | Live pull → Supabase calling list |
| `permits_contractors_*` | Cached + pulled GC summary/query/sample/export |
| `save_calling_list` | Write a filtered DFW pull to Supabase (`owner` e.g. `cayden`) |
| `import_calling_list_csv` | Import Houston/Harris or any external contractor CSV |
| `list_calling_lists` / `query_calling_list` | Find and filter saved lists (`exclude_national_chains`, `dial_status=owner_cell`) |
| `score_calling_list` | Free owner vs office score (`only_unscored`, offset, up to 8k) |
| `match_texas_officers` | Texas Comptroller PIR officers (`only_unmatched`, limit 50, resume) |
| `lookup_line_type` | Veriphone Standard (~$2.40/1k) cell vs landline |
| `owner_people_search` / `record_owner_cell` | Google + free people-search leftovers |
| `set_enrichment_api_key` | Cayden pastes Veriphone / Texas CPA keys |
| `parcels_*` | CAD parcel summary/query/sample/export |
| `build_operators` | Mailing-address operator rollup → `permit_parcel.operators` (counts only) |
| `sync_to_supabase` | Full matching-set S2S sync — **counts only**; contractor syncs also catalog a calling list |

Prefer save/sync + SQL `select count(*)` over dumping rows into chat.

Claude connector: `https://workspace-production-4702.up.railway.app/mcp` (authless).

## PermitStack requests

Live pulls use [PermitStack](https://permit-stack.com/docs/) (`X-API-Key`, OpenAPI at `https://api.permit-stack.com/public-openapi.json`). Geos resolve locally — there is no Shovels `geo_id`. Cities/counties call `GET /v1/contractors/search?city=&state=`; ZIPs use `GET /v1/permits/search?zip_code=`. `permitstack_estimate_credits` (alias `shovels_estimate_credits`) probes one page per geo and quotes `credits.estimated_requests`. Phone/email are on contractor profiles (Developer plan and up).

Set `PERMITSTACK_API_KEY` on Railway, or have Cayden paste it with `permitstack_set_api_key` (`confirm=true`). The server never echoes the full key. The value is stored in `permit_parcel.app_settings` (`shovels_api_key` slot) and reloaded on restart.

## Calling lists (Cayden)

1. Optional: `shovels_set_api_key` if he wants to use his own Shovels key
2. Estimate (optional): `shovels_estimate_credits` with place/city/`has_phone`
3. Save: `save_calling_list` with `owner=cayden` and `exclude_national_chains=true` (keeps local GCs of any permit volume). Non-DFW: `import_calling_list_csv`.
4. `score_calling_list(only_unscored=true)` until `remaining_unscored=0` → `match_texas_officers(only_unmatched=true, limit=50)` until `remaining_unmatched=0` → `lookup_line_type` (confirm $ first)
5. Leftovers: `owner_people_search` then `record_owner_cell` for wireless hits
6. Dial: `query_calling_list(owner=cayden, exclude_national_chains=true, dial_status=owner_cell)`

Apply `supabase/migrations/20260824_enrichment_pipeline_scale.sql` so `query_calling_list` works (the `matched` CTE bug) and resume filters exist.

Shovels `/v2/counties/{geo_id}/metrics/current` has returned HTTP 500 while the rest of their API (including `/metrics/monthly`) stayed healthy. Treat that as a Shovels outage, not a key problem.

## Sync rules

- No silent 50k truncation — syncs the full matching set (`truncated: false`)
- Honours `county` (and other parcel filters)
- Fails if `rows_inserted > 0` but `permit_parcel_schema_upserted = 0`
- Natural key `(county, account_id)` with stable id `county:account_id`

## Free LLC unmasking (do not buy)

Do **not** bulk-buy paid SOS products for tens of thousands of LLCs. Cheapest path:

1. Filter by `min_assessed_value`
2. `build_operators` — resolve mailing-address operators, not every shell entity
3. Join Texas Comptroller **Public Information Report** (Form 05-102) bulk files (Open Data Portal / Open Records) — free

Registered agents (CT Corporation, law firms) are **not** owners — prefer PIR officer/director fields.

## Data

Normalized commercial CSVs (refresh annually):

- `data/parcels/dcad/commercial_parcels.csv`
- `data/parcels/tad/commercial_parcels.csv`
- `data/parcels/ccad/commercial_parcels.csv`
- `data/shovels_commercial_contractors/commercial_contractors_contacts.csv`

## Env

```bash
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_INGEST_SECRET=
SHOVELS_API_KEY=   # optional fallback; Cayden can set the live key from Claude
VERIPHONE_API_KEY= # or paste via set_enrichment_api_key
TEXAS_CPA_API_KEY= # Comptroller public API; or paste via Claude
```

## Run

```bash
npm install
npm run build
npm start
# MCP: https://<host>/mcp  (authless)
```

## Owner-type routing

- `individual` — owner is decision maker
- `local_llc` — operators + free Comptroller PIR
- `institutional` — drop from private-operator outreach
- `municipal` — city / county / ISD / housing authority / etc. (segmentable)
- `unknown` — residual
