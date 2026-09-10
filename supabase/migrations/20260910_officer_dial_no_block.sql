-- Recompute officer_match + dial_status for stored registry hits.
-- No Sunbiz / Comptroller traffic. Existing officer_match='match' rows are left as match.

-- PermitStack (and any no_dm) contacts that already have a human officer were
-- stamped `different`. That is a resolution, not a conflict.
UPDATE permit_parcel.contact_enrichment e
SET officer_match = 'resolved'
FROM public.scrape_leads sl
WHERE e.list_id = sl.job_id
  AND e.lead_id = sl.id
  AND e.officer_match = 'different'
  AND e.officer_name IS NOT NULL
  AND (
    e.owner_score = 'no_dm'
    OR coalesce(e.evidence, '') ILIKE '%looks like the company, not a person%'
    OR upper(trim(coalesce(sl.owner_name, ''))) = upper(trim(coalesce(sl.name, '')))
  );

-- Identity-confirmed verified mobiles → owner_cell. Do not touch skip/invalid.
UPDATE permit_parcel.contact_enrichment e
SET
  dial_status = 'owner_cell',
  owner_cell = coalesce(nullif(e.owner_cell, ''), sl.phone),
  owner_cell_source = coalesce(e.owner_cell_source, 'shovels_mobile')
FROM public.scrape_leads sl
WHERE e.list_id = sl.job_id
  AND e.lead_id = sl.id
  AND e.phone_line_type = 'mobile'
  AND e.officer_match IN ('match', 'resolved')
  AND coalesce(e.dial_status, '') NOT IN ('skip');

-- agent / leftover different / none must not hold a verified mobile in needs_enrichment.
UPDATE permit_parcel.contact_enrichment e
SET dial_status = 'mobile_unverified_owner'
WHERE e.phone_line_type = 'mobile'
  AND e.officer_match IN ('agent', 'different', 'none', 'unavailable')
  AND coalesce(e.dial_status, 'needs_enrichment') = 'needs_enrichment'
  AND e.owner_cell IS NULL;
