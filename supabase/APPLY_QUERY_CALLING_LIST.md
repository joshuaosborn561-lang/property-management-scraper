# Josh: apply `query_calling_list` SQL (5 minutes)

Railway is already on the new Node build. **This SQL is the remaining fix.** Until it runs, MCP `query_calling_list` returns:

```text
{"ok": false, "error": "relation \"matched\" does not exist"}
```

Repro: `query_calling_list(list_id="permit-contractors-29aa0262", dial_status="needs_enrichment", page_size=1)`

## Why

`public.query_permit_parcel_calling_list` used a CTE named `matched` in one `SELECT`, then queried `matched` again as a table. Postgres drops CTEs after the first statement.

This file replaces that function (single statement) and updates `fetch_permit_parcel_calling_list_contacts` so score/officer match can resume past 2,000 rows.

## Steps

1. Open **SQL Editor** on project **`kemvxzhcxvynmoutwdrh`**  
   https://supabase.com/dashboard/project/kemvxzhcxvynmoutwdrh/sql/new
2. Copy **all** of [`migrations/20260824_enrichment_pipeline_scale.sql`](./migrations/20260824_enrichment_pipeline_scale.sql)
3. Paste → **Run**
4. Confirm no error (a `DROP FUNCTION IF EXISTS` notice is fine)
5. Reply on the PR that it’s applied

## Verify

In SQL Editor:

```sql
select proname, pg_get_function_identity_arguments(oid) as args
from pg_proc
where proname in (
  'query_permit_parcel_calling_list',
  'fetch_permit_parcel_calling_list_contacts'
)
order by 1, 2;
```

Then in Claude / MCP, retry the repro above. Expect `"ok": true` and a `total`.

## Do not

- Do not run this on a different Supabase project (Maps scraper vs this one — health reports `kemvxzhcxvynmoutwdrh`)
- Do not split the file into multiple editor runs
- No Railway redeploy is required after this SQL
