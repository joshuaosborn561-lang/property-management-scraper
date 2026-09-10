# Permit & Parcel MCP (`permits-GCs`)

Repo: https://github.com/joshuaosborn561-lang/permits-GCs

Use for Shovels commercial GCs, letting Cayden set API keys from Claude, owner-cell enrichment (Texas Comptroller / Florida Sunbiz + Veriphone + people search), credit estimates, Supabase calling lists, and DCAD/TAD/CCAD commercial parcels.

Do not use Propwire/LoopNet. Prefer `save_calling_list` / `sync_to_supabase` + count(*) over row dumps.
Never echo a full API key — only the masked fingerprint from `shovels_api_key_status`.
Drop institutional owners.
