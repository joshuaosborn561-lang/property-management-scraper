-- Distinguish never-attempted officer_match (NULL) from attempted-no-match ('none').
-- Score upserts must not seed 'none'. Imported / scored rows with a bare 'none'
-- and no CPA evidence are treated as unmatched so match_texas_officers can run.

ALTER TABLE permit_parcel.contact_enrichment
  ALTER COLUMN officer_match DROP DEFAULT;

UPDATE permit_parcel.contact_enrichment
SET officer_match = NULL
WHERE officer_match = 'none'
  AND taxpayer_id IS NULL
  AND officer_name IS NULL
  AND coalesce(evidence, '') = '';

CREATE OR REPLACE FUNCTION public.fetch_permit_parcel_calling_list_contacts(
  p_secret text,
  p_list_id text,
  p_limit integer DEFAULT 500,
  p_offset integer DEFAULT 0,
  p_unscored_only boolean DEFAULT false,
  p_unmatched_only boolean DEFAULT false,
  p_unknown_line_type_only boolean DEFAULT false,
  p_lead_id bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'permit_parcel'
AS $function$
declare
  expected text;
  rows jsonb;
  total_n integer := 0;
  unscored_n integer := 0;
  unmatched_n integer := 0;
  unknown_line_n integer := 0;
  lim integer := greatest(1, least(coalesce(p_limit, 500), 8000));
  off integer := greatest(0, coalesce(p_offset, 0));
begin
  select value into expected from private.app_secrets where key = 'ingest_secret';
  if expected is null or p_secret is distinct from expected then
    raise exception 'unauthorized';
  end if;

  if p_list_id is null or p_list_id = '' then
    return jsonb_build_object('ok', false, 'error', 'list_id required', 'rows', '[]'::jsonb);
  end if;

  select
    count(*)::int,
    count(*) filter (where e.owner_score is null)::int,
    count(*) filter (
      where e.officer_match is null
         or (
           e.officer_match = 'none'
           and e.taxpayer_id is null
           and e.officer_name is null
           and coalesce(e.evidence, '') = ''
         )
    )::int,
    count(*) filter (
      where e.phone_line_type is null
        and (
          length(regexp_replace(coalesce(sl.phone, ''), '\D', '', 'g')) = 10
          or (
            length(regexp_replace(coalesce(sl.phone, ''), '\D', '', 'g')) = 11
            and regexp_replace(coalesce(sl.phone, ''), '\D', '', 'g') like '1%'
          )
        )
    )::int
  into total_n, unscored_n, unmatched_n, unknown_line_n
  from public.scrape_leads sl
  left join permit_parcel.contact_enrichment e
    on e.list_id = sl.job_id and e.lead_id = sl.id
  where sl.job_id = p_list_id
    and (p_lead_id is null or sl.id = p_lead_id);

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
  into rows
  from (
    select
      sl.job_id as list_id,
      sl.id as lead_id,
      sl.place_id,
      sl.name as company_name,
      sl.owner_name as contact_name,
      sl.phone,
      sl.email,
      sl.city,
      sl.state,
      sl.zip,
      e.owner_score,
      e.flags,
      e.email_kind,
      e.phone_line_type,
      e.phone_carrier,
      e.officer_name,
      e.officer_title,
      e.officer_street,
      e.officer_city,
      e.officer_state,
      e.officer_zip,
      e.officer_match,
      e.taxpayer_id,
      e.owner_search_name,
      e.people_search,
      e.owner_cell,
      e.owner_cell_source,
      e.dial_status,
      e.evidence
    from public.scrape_leads sl
    left join permit_parcel.contact_enrichment e
      on e.list_id = sl.job_id and e.lead_id = sl.id
    where sl.job_id = p_list_id
      and (p_lead_id is null or sl.id = p_lead_id)
      and (p_unscored_only is not true or e.owner_score is null)
      and (
        p_unmatched_only is not true
        or e.officer_match is null
        or (
          e.officer_match = 'none'
          and e.taxpayer_id is null
          and e.officer_name is null
          and coalesce(e.evidence, '') = ''
        )
      )
      and (
        p_unknown_line_type_only is not true
        or (
          e.phone_line_type is null
          and (
            length(regexp_replace(coalesce(sl.phone, ''), '\D', '', 'g')) = 10
            or (
              length(regexp_replace(coalesce(sl.phone, ''), '\D', '', 'g')) = 11
              and regexp_replace(coalesce(sl.phone, ''), '\D', '', 'g') like '1%'
            )
          )
        )
      )
    order by sl.name nulls last, sl.id
    offset off
    limit lim
  ) x;

  return jsonb_build_object(
    'ok', true,
    'rows', rows,
    'total', total_n,
    'offset', off,
    'limit', lim,
    'returned', coalesce(jsonb_array_length(rows), 0),
    'remaining_unscored', unscored_n,
    'remaining_unmatched', unmatched_n,
    'remaining_unknown_line_type', unknown_line_n
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_permit_parcel_enrichment(
  p_secret text,
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'permit_parcel'
AS $function$
declare
  expected text;
  n integer := 0;
begin
  select value into expected from private.app_secrets where key = 'ingest_secret';
  if expected is null or p_secret is distinct from expected then
    raise exception 'unauthorized';
  end if;

  insert into permit_parcel.contact_enrichment (
    list_id, lead_id, place_id, company_name, contact_name, phone, email,
    owner_score, flags, email_kind, phone_line_type, phone_carrier,
    officer_name, officer_title, officer_street, officer_city, officer_state, officer_zip,
    officer_match, taxpayer_id, owner_search_name, people_search,
    owner_cell, owner_cell_source, dial_status, evidence, updated_at
  )
  select
    coalesce(r->>'list_id', ''),
    (r->>'lead_id')::bigint,
    nullif(r->>'place_id', ''),
    r->>'company_name',
    r->>'contact_name',
    r->>'phone',
    r->>'email',
    r->>'owner_score',
    coalesce(r->'flags', '[]'::jsonb),
    r->>'email_kind',
    r->>'phone_line_type',
    r->>'phone_carrier',
    r->>'officer_name',
    r->>'officer_title',
    r->>'officer_street',
    r->>'officer_city',
    r->>'officer_state',
    r->>'officer_zip',
    nullif(r->>'officer_match', ''),
    r->>'taxpayer_id',
    r->>'owner_search_name',
    r->'people_search',
    r->>'owner_cell',
    r->>'owner_cell_source',
    coalesce(nullif(r->>'dial_status', ''), 'needs_enrichment'),
    r->>'evidence',
    now()
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  where nullif(r->>'list_id', '') is not null
    and nullif(r->>'lead_id', '') is not null
  on conflict (list_id, lead_id) do update set
    place_id = excluded.place_id,
    company_name = excluded.company_name,
    contact_name = excluded.contact_name,
    phone = excluded.phone,
    email = excluded.email,
    owner_score = excluded.owner_score,
    flags = excluded.flags,
    email_kind = excluded.email_kind,
    phone_line_type = coalesce(nullif(excluded.phone_line_type, ''), permit_parcel.contact_enrichment.phone_line_type),
    phone_carrier = coalesce(nullif(excluded.phone_carrier, ''), permit_parcel.contact_enrichment.phone_carrier),
    officer_name = excluded.officer_name,
    officer_title = excluded.officer_title,
    officer_street = excluded.officer_street,
    officer_city = excluded.officer_city,
    officer_state = excluded.officer_state,
    officer_zip = excluded.officer_zip,
    officer_match = coalesce(nullif(excluded.officer_match, ''), permit_parcel.contact_enrichment.officer_match),
    taxpayer_id = excluded.taxpayer_id,
    owner_search_name = excluded.owner_search_name,
    people_search = excluded.people_search,
    owner_cell = coalesce(nullif(excluded.owner_cell, ''), permit_parcel.contact_enrichment.owner_cell),
    owner_cell_source = coalesce(nullif(excluded.owner_cell_source, ''), permit_parcel.contact_enrichment.owner_cell_source),
    dial_status = excluded.dial_status,
    evidence = excluded.evidence,
    updated_at = now();

  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'upserted', n);
end;
$function$;

GRANT EXECUTE ON FUNCTION public.fetch_permit_parcel_calling_list_contacts(text, text, integer, integer, boolean, boolean, boolean, bigint) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_permit_parcel_enrichment(text, jsonb) TO anon, authenticated, service_role;
