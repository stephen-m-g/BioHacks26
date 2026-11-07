import type { Asset } from '../types'
import { assetPublicUrl } from './supabase'

/** URL for an asset's file. Demo assets carry a data: URI in storage_path. */
export function assetUrl(asset: Asset | undefined | null): string {
  if (!asset?.storage_path) return ''
  if (asset.storage_path.startsWith('data:')) return asset.storage_path
  return assetPublicUrl(asset.storage_path)
}

export const nowIso = () => new Date().toISOString()

export const newId = () => crypto.randomUUID()
