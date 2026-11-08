/**
 * The read-only annotation popover is transient: it follows hover or keyboard focus, never the page's
 * selected annotation. `tap` is the touch preview used only where a circle has nowhere to navigate.
 */
export type PopoverState = { id: string; via: 'hover' | 'focus' | 'tap' } | null

export type PopoverEvent =
  | { type: 'enter'; id: string }
  | { type: 'leave'; id: string }
  | { type: 'focus'; id: string }
  | { type: 'blur'; id: string }
  | { type: 'activate'; id: string; navigates: boolean }
  | { type: 'dismiss' }

export function popoverReducer(state: PopoverState, event: PopoverEvent): PopoverState {
  switch (event.type) {
    case 'enter':
      return { id: event.id, via: 'hover' }
    case 'focus':
      return { id: event.id, via: 'focus' }
    case 'leave':
      return state?.id === event.id && state.via === 'hover' ? null : state
    case 'blur':
      return state?.id === event.id && state.via === 'focus' ? null : state
    case 'activate':
      if (event.navigates) return null
      return state?.id === event.id && state.via === 'tap' ? null : { id: event.id, via: 'tap' }
    case 'dismiss':
      return null
  }
}

/** Pointer-downs on this image's own circles or popover are handled there; anything else is outside. */
export function isAnnotationTarget(target: Element | null, root: Element | null): boolean {
  if (!target || !root) return false
  return !!target.closest('.annotation-popover, .lasso-confirmed.hoverable') && root.contains(target)
}

export const annotationCardId = (annotationId: string) => `annotation-card-${annotationId}`
