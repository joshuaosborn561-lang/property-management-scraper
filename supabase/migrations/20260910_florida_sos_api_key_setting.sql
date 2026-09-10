-- One allow-list for Claude-settable keys. Keep in sync with SETTING_KEYS in
-- src/server/lib/appSettings.ts. Earlier migrations disagreed
-- (owner_cell allowed three keys; shovels_api_key_setting allowed only one).

CREATE OR REPLACE FUNCTION permit_parcel.app_setting_key_allowed(p_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_key IN (
    'shovels_api_key',
    'veriphone_api_key',
    'texas_cpa_api_key',
    'florida_sos_api_key'
  );
$$;

CREATE OR REPLACE FUNCTION public.fetch_permit_parcel_setting(
  p_secret text,
  p_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'permit_parcel'
AS $function$
declare
  expected text;
  row_json jsonb;
begin
  select value into expected from private.app_secrets where key = 'ingest_secret';
  if expected is null or p_secret is distinct from expected then
    raise exception 'unauthorized';
  end if;

  if p_key is null or not permit_parcel.app_setting_key_allowed(p_key) then
    raise exception 'unknown setting';
  end if;

  select jsonb_build_object(
    'ok', true,
    'found', true,
    'key', s.key,
    'value', s.value,
    'updated_by', s.updated_by,
    'updated_at', s.updated_at
  )
  into row_json
  from permit_parcel.app_settings s
  where s.key = p_key;

  if row_json is null then
    return jsonb_build_object('ok', true, 'found', false, 'key', p_key);
  end if;
  return row_json;
end;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_permit_parcel_setting(
  p_secret text,
  p_key text,
  p_value text,
  p_updated_by text DEFAULT 'cayden'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'permit_parcel'
AS $function$
declare
  expected text;
begin
  select value into expected from private.app_secrets where key = 'ingest_secret';
  if expected is null or p_secret is distinct from expected then
    raise exception 'unauthorized';
  end if;

  if p_key is null or not permit_parcel.app_setting_key_allowed(p_key) then
    raise exception 'unknown setting';
  end if;

  insert into permit_parcel.app_settings (key, value, updated_by, updated_at)
  values (p_key, coalesce(p_value, ''), coalesce(nullif(p_updated_by, ''), 'cayden'), now())
  on conflict (key) do update set
    value = excluded.value,
    updated_by = excluded.updated_by,
    updated_at = now();

  return jsonb_build_object('ok', true, 'key', p_key, 'updated_by', coalesce(nullif(p_updated_by, ''), 'cayden'));
end;
$function$;

GRANT EXECUTE ON FUNCTION public.fetch_permit_parcel_setting(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_permit_parcel_setting(text, text, text, text) TO anon, authenticated, service_role;
