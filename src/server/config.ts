import dotenv from 'dotenv';

dotenv.config();

function env(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}

function envBool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  port: Number(env('PORT', '8080')),
  demoMode: envBool('DEMO_MODE', false),
  supabaseUrl: env('SUPABASE_URL'),
  supabaseAnonKey: env('SUPABASE_ANON_KEY'),
  supabaseIngestSecret: env('SUPABASE_INGEST_SECRET'),
  supabaseServiceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
  permitstackApiKey: env('PERMITSTACK_API_KEY') || env('SHOVELS_API_KEY'),
  permitstackBaseUrl: env('PERMITSTACK_BASE_URL', 'https://api.permit-stack.com'),
  /** @deprecated use permitstackApiKey */
  shovelsApiKey: env('PERMITSTACK_API_KEY') || env('SHOVELS_API_KEY'),
  shovelsBaseUrl: env('PERMITSTACK_BASE_URL', 'https://api.permit-stack.com'),
  veriphoneApiKey: env('VERIPHONE_API_KEY'),
  texasCpaApiKey: env('TEXAS_CPA_API_KEY'),
};

export type AppConfig = typeof config;
