// Pure helpers for the lecture prep page (no React or Supabase imports so node:test can load it).

export interface SaveButtonInput {
  isNew: boolean
  /** The lecture row has loaded. */
  loaded: boolean
  /** A save or discard is running. */
  busy: boolean
  /** Materials successfully stored for this lecture (uploads that failed or are still running don't count). */
  materialCount: number
  /** Uploads or typed notes still being written. */
  pending: number
}

/** A new lecture can be saved once it has at least one stored material; an existing one any time. */
export function canSaveLecture({ isNew, loaded, busy, materialCount, pending }: SaveButtonInput): boolean {
  if (!loaded || busy || pending > 0) return false
  return !isNew || materialCount > 0
}

/** The back arrow asks when something would be lost; a brand-new lecture always asks (not saving deletes it). */
export function backAction(hasUnsavedWork: boolean, isNew: boolean): 'confirm' | 'leave' {
  return hasUnsavedWork || isNew ? 'confirm' : 'leave'
}

export interface SaveLecturePlan {
  /** Rename the lecture; absent when the title didn't change. */
  updateTitle?: () => Promise<void>
  /** Delete previously saved materials the teacher removed. */
  deleteRemoved: () => Promise<void>
  /** Write the class selection; absent when it didn't change. */
  updateClasses?: () => Promise<void>
  navigate: (to: string) => void
}

/** The one save path (Save lecture button and the back arrow's Save): apply changes, then go to the dashboard. */
export async function saveLecture(plan: SaveLecturePlan): Promise<void> {
  await plan.updateTitle?.()
  await plan.deleteRemoved()
  await plan.updateClasses?.()
  plan.navigate('/')
}
