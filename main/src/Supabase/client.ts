import { createClient } from '@supabase/supabase-js';
import { safeLocalStorage } from '../utils/safeLocalStorage';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_API) as string;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.');
}

if (supabaseAnonKey.includes('secret') || supabaseAnonKey.startsWith('sb_secret_')) {
  throw new Error('⚠️ SECURITY ERROR: You are using a SERVICE ROLE KEY (secret key) in the browser.\n\n' +
    'Please replace VITE_SUPABASE_ANON_KEY in your .env file with the ANON PUBLIC key.\n' +
    'Get it from: Supabase Dashboard → Settings → API → Project API keys → anon public');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: safeLocalStorage,
    flowType: 'pkce',
  }
});

export type DbUser = {
  id: string;
  email: string | null;
};
