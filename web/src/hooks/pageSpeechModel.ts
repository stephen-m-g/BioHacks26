// Which PDF page the teacher's speech belongs to (P1/P3). No React or SDK imports so node:test can load it.
//
// The active page is the page the teacher is looking at (see activePageAt), or the page he last touched. Every
// change is recorded with its time, and each spoken word is assigned to the page that was active when the word
// was spoken (ElevenLabs word timestamps), so a transcript that arrives seconds later still lands on the right page.

/** Remembers when each PDF page became active; `null` entries mean no page (ordinary speech). */
export class PageTimeline {
  private entries: { at: number; pageBlockId: string | null }[] = []

  private readonly keepMs: number

  constructor(keepMs = 10 * 60_000) {
    this.keepMs = keepMs
  }

  set(pageBlockId: string | null, at: number): void {
    const last = this.entries.at(-1)
    if (last && last.pageBlockId === pageBlockId) return
    this.entries.push({ at: Math.max(at, last?.at ?? at), pageBlockId })
    // Drop history older than any transcript could still be in flight, keeping the entry in force at the cutoff.
    const cutoff = at - this.keepMs
    while (this.entries.length > 1 && this.entries[1].at <= cutoff) this.entries.shift()
  }

  /** The page active at `ms`; undefined before the first recorded change (the caller's fallback applies). */
  at(ms: number): string | null | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].at <= ms) return this.entries[i].pageBlockId
    }
    return undefined
  }

  get current(): string | null {
    return this.entries.at(-1)?.pageBlockId ?? null
  }
}

/** A board item (page, paragraph, image, live text) in board order, in viewport coordinates. */
export interface BoardItemBox {
  top: number
  bottom: number
  /** The page this item belongs to (a page or a paragraph under it); null for everything else. */
  owner: string | null
}

/** The reading line sits this fraction of the board's visible height below its top. */
export const READING_LINE = 0.35

/**
 * The page the teacher is looking at: the owner of the board item crossing the reading line (in a gap between
 * items, the item just above it). Reading a page's own paragraphs keeps that page active; an ordinary image or
 * paragraph means no page, so speech goes to the end of the board as usual.
 */
export function activePageAt(items: BoardItemBox[], line: number): string | null {
  let above: BoardItemBox | undefined
  for (const item of items) {
    if (item.top <= line && line < item.bottom) return item.owner
    if (item.top <= line) above = item
  }
  return (above ?? items[0])?.owner ?? null
}

/** Scroll events this soon after the teacher's own wheel/touch/key/pointer input count as his scrolling. */
export const USER_SCROLL_WINDOW_MS = 1_500
/** The active page only changes once scrolling has settled this long, so passing pages don't take speech. */
export const PAGE_SETTLE_MS = 300

/** Only scrolling the teacher did himself may change the page (auto-scroll and "show this PDF" may not). */
export function isUserScroll(lastUserInputAt: number, now: number): boolean {
  return now - lastUserInputAt <= USER_SCROLL_WINDOW_MS
}
