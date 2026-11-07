import { useEffect, useRef, type DependencyList, type RefObject } from 'react'

/**
 * Keep a scroll container pinned to the bottom when content grows, unless the user scrolled up
 * or `hold()` returns true (e.g. while the teacher is working on a diagram).
 */
export function useAutoScroll(ref: RefObject<HTMLElement | null>, deps: DependencyList, hold?: () => boolean) {
  const pinned = useRef(true)
  const holdRef = useRef(hold)
  holdRef.current = hold

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref])

  useEffect(() => {
    const el = ref.current
    if (!el || !pinned.current || holdRef.current?.()) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
