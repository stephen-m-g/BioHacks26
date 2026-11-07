// Teacher mic state (P3). No React imports so node:test can load it.

/**
 * The session the teacher turned the mic on in, or null while it is off. Keying it by session
 * means a new, reloaded or resumed session always opens with the mic off.
 */
export type MicState = string | null

export const MIC_OFF: MicState = null

export function turnMicOn(sessionId: string): MicState {
  return sessionId
}

export function isMicOn(state: MicState, sessionId: string): boolean {
  return state !== null && state === sessionId
}

/** Only an explicit turn-on in this session, while it is live, may open the mic or mint a token. */
export function shouldRecord(state: MicState, sessionId: string, status: string | undefined): boolean {
  return isMicOn(state, sessionId) && status === 'live'
}
