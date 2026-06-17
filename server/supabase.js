// Supabase clients. The backend uses the SERVICE ROLE key (server-only, never
// sent to the browser) for all data + storage operations. The ANON key is
// public and handed to the frontend via /api/config so it can do auth.
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

export const isConfigured = () => Boolean(URL && SERVICE_KEY && ANON_KEY);

export const publicConfig = () => ({ url: URL, anonKey: ANON_KEY, configured: isConfigured() });

// Admin client — bypasses RLS. We always filter by user_id ourselves.
export const admin = isConfigured()
  ? createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

export const BUCKET = 'orbital-files';

// Verify a user's access token and return their auth user (or null).
export async function getUserFromToken(token) {
  if (!admin || !token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error) return null;
  return data.user || null;
}
