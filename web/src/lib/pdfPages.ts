// Pure helpers for PDFs on the board (no React or Supabase imports so node:test can load it).
// A PDF asset's pages are 'pdf_page' assets (source_asset_id = the PDF); each placed page is an image block.
import type { Asset, Block } from '../types'

type PageAsset = Pick<Asset, 'id' | 'kind' | 'source_asset_id' | 'page_number'>
type PdfAsset = Pick<Asset, 'id' | 'page_count'>

/** The PDF's rendered pages in page order. */
export function pagesOf<T extends PageAsset>(assets: Iterable<T>, pdfId: string): T[] {
  return [...assets]
    .filter((a) => a.kind === 'pdf_page' && a.source_asset_id === pdfId)
    .sort((a, b) => (a.page_number ?? 0) - (b.page_number ?? 0))
}

/** Every page has been rendered (the server sets page_count last). */
export function pdfPagesReady(pdf: PdfAsset, pages: PageAsset[]): boolean {
  const count = pdf.page_count ?? 0
  return count > 0 && pages.length === count && pages.every((p, i) => p.page_number === i + 1)
}

/**
 * Positions for `count` new blocks dropped into one slot, in order, strictly between the neighbours.
 * For one block this is the board's usual rule: 1 on an empty board, ±1 at either end, else the midpoint.
 */
export function slotPositions(prev: number | undefined, next: number | undefined, count: number): number[] {
  const steps = Array.from({ length: count }, (_, i) => i + 1)
  if (prev === undefined && next === undefined) return steps
  if (prev === undefined) return steps.map((i) => next! - (count + 1 - i))
  if (next === undefined) return steps.map((i) => prev + i)
  return steps.map((i) => prev + ((next - prev) * i) / (count + 1))
}

export interface PageInfo {
  pdfId: string
  pageNumber: number
  pageCount: number | null
  fileName: string
}

/** PDF page details for an image block showing a page; null for ordinary images and text. */
export function pageInfo(block: Pick<Block, 'kind' | 'asset_id'>, assets: Record<string, Asset>): PageInfo | null {
  if (block.kind !== 'image' || !block.asset_id) return null
  const page = assets[block.asset_id]
  if (page?.kind !== 'pdf_page' || !page.source_asset_id) return null
  const pdf = assets[page.source_asset_id]
  return {
    pdfId: page.source_asset_id,
    pageNumber: page.page_number ?? 0,
    pageCount: pdf?.page_count ?? null,
    fileName: pdf?.file_name || pdf?.label || 'PDF',
  }
}

/** "Page 2 of 4" (or "Page 2" if the count is unknown). */
export function pageLabel(info: Pick<PageInfo, 'pageNumber' | 'pageCount'>): string {
  return info.pageCount ? `Page ${info.pageNumber} of ${info.pageCount}` : `Page ${info.pageNumber}`
}

/**
 * The page each board block belongs to: a page block itself, or a paragraph refined from speech under that page
 * (blocks.page_block_id). Ordinary images and paragraphs, and paragraphs whose page isn't on the board, get null.
 */
export function pageOwners(
  blocks: Pick<Block, 'id' | 'kind' | 'asset_id' | 'page_block_id'>[],
  assets: Record<string, Asset>,
): Map<string, string | null> {
  const pages = new Set(blocks.filter((b) => pageInfo(b, assets)).map((b) => b.id))
  return new Map(
    blocks.map((b) => [b.id, pages.has(b.id) ? b.id : b.page_block_id && pages.has(b.page_block_id) ? b.page_block_id : null]),
  )
}

/** The first board block showing a page of this PDF, if the PDF is already on the board. */
export function pdfFirstBlockOnBoard(
  blocks: Pick<Block, 'id' | 'kind' | 'asset_id'>[],
  assets: Record<string, Asset>,
  pdfId: string,
): string | null {
  return blocks.find((b) => pageInfo(b, assets)?.pdfId === pdfId)?.id ?? null
}
