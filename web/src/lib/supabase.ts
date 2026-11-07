import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigured = Boolean(url && anonKey)

if (!supabaseConfigured) {
  console.warn('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY: copy web/.env.example to web/.env.local')
}

export const supabase = createClient(url || 'http://localhost:54321', anonKey || 'missing-anon-key')

/** Public URL for a file in the "assets" storage bucket. */
export function assetPublicUrl(storagePath: string): string {
  return supabase.storage.from('assets').getPublicUrl(storagePath).data.publicUrl
}
