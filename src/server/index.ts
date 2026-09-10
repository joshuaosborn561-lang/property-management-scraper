import cors from 'cors';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { mountMcpHttp } from '../mcp/http.js';
import { config } from './config.js';
import { hasSupabase, SCHEMA } from './lib/supabase.js';
import { supabaseTargetMeta } from './lib/supabaseTarget.js';
import { enrichmentKeysStatus, loadAppSettings } from './lib/appSettings.js';
import { getShovelsKeyStatus } from './lib/shovelsKey.js';
import { callingListsRouter } from './routes/callingLists.js';
import { parcelsRouter } from './routes/parcels.js';
import { shovelsApiKeyRouter } from './routes/shovelsApiKey.js';
import { shovelsContractorsRouter } from './routes/shovelsContractors.js';
import { buildOperators } from './services/operators.js';
import { loadParcels, parcelsSummary } from './services/parcels.js';
import { loadShovelsContractors } from './services/shovelsContractors.js';
import { syncToSupabase } from './services/syncToSupabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

app.get('/api/health', async (_req, res) => {
  const target = supabaseTargetMeta();
  const shovelsKey = await getShovelsKeyStatus();
  res.json({
    ok: true,
    product: 'Permit & Parcel MCP',
    demoMode: config.demoMode,
    supabaseConfigured: hasSupabase(),
    supabase_project: target.supabase_project,
    supabase_schema: target.supabase_schema ?? SCHEMA,
    supabase_url: target.supabase_url,
    permitstackApiConfigured: shovelsKey.configured,
    permitstack_api_key: shovelsKey,
    shovelsApiConfigured: shovelsKey.configured,
    shovels_api_key: shovelsKey,
    enrichment_keys: await enrichmentKeysStatus(),
    shovelsContractorsLoaded: loadShovelsContractors().length,
    parcelsLoaded: loadParcels().length,
    parcels: parcelsSummary(),
    mcp: {
      streamableHttp: '/mcp',
      health: '/mcp/health',
      stdio: 'node dist/mcp/stdio.js',
    },
  });
});

app.use('/api/parcels', parcelsRouter);
app.use('/api/shovels/contractors', shovelsContractorsRouter);
app.use('/api/shovels/api-key', shovelsApiKeyRouter);
app.use('/api/calling-lists', callingListsRouter);

app.post('/api/sync-to-supabase', async (req, res) => {
  try {
    const dataset = String(req.body?.dataset ?? 'all') as 'parcels' | 'contractors' | 'all';
    const result = await syncToSupabase({
      dataset: ['parcels', 'contractors', 'all'].includes(dataset) ? dataset : 'all',
      parcel_query: {
        county: req.body?.county,
        owner_type: req.body?.owner_type,
        q: req.body?.q,
      },
      contractor_query: {
        place: req.body?.place,
        q: req.body?.q,
      },
      list_name: req.body?.list_name,
      owner: req.body?.owner,
    });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'sync failed' });
  }
});

app.post('/api/build-operators', async (req, res) => {
  try {
    const result = await buildOperators(req.body ?? {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'build_operators failed' });
  }
});

mountMcpHttp(app);

/** Claude OAuth discovery probes — return clean 404 JSON, not SPA HTML. */
app.use((req, res, next) => {
  const p = req.path;
  if (
    p.startsWith('/.well-known/oauth-authorization-server') ||
    p.startsWith('/.well-known/openid-configuration') ||
    p.startsWith('/.well-known/oauth-protected-resource') ||
    p === '/register' ||
    p === '/oauth/register'
  ) {
    res.status(404).json({
      error: 'not_found',
      message:
        'This MCP server does not use OAuth. Connect as an authless custom connector (leave Client ID blank).',
    });
    return;
  }
  next();
});

const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.use((req, res, next) => {
  if (
    req.method !== 'GET' ||
    req.path.startsWith('/api/') ||
    req.path.startsWith('/mcp') ||
    req.path.startsWith('/.well-known/')
  ) {
    return next();
  }
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next();
  });
});

app.listen(config.port, () => {
  void loadAppSettings().then(() =>
    enrichmentKeysStatus().then((keys) => {
      console.log(
        `Keys: permitstack=${keys.shovels_api_key.configured ? keys.shovels_api_key.masked : 'unset'} veriphone=${keys.veriphone_api_key.configured ? keys.veriphone_api_key.masked : 'unset'} cpa=${keys.texas_cpa_api_key.configured ? keys.texas_cpa_api_key.masked : 'unset'}`,
      );
    }),
  );
  const contractors = loadShovelsContractors();
  const parcels = loadParcels();
  console.log(`Permit & Parcel MCP listening on :${config.port}`);
  console.log(`MCP streamable HTTP: /mcp  |  stdio: node dist/mcp/stdio.js`);
  console.log(
    `Mode: ${config.demoMode ? 'DEMO' : 'LIVE'} | Supabase: ${hasSupabase() ? 'yes' : 'no'} | Contractors: ${contractors.length} | Parcels: ${parcels.length}`,
  );
});
