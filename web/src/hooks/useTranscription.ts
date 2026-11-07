// P3 owns this hook. Starts when /teach mounts.
// TODO (P3): webkitSpeechRecognition (continuous, interimResults, 'en-CA', auto-restart in onend)
// or Deepgram fallback. On each final result insert transcript_segments with
// slide_id = store.currentSlideId and annotation_id = store.pendingAnnotationId, then
// fire-and-forget api.cleanSegment(id).
export function useTranscription(_sessionId: string | null) {
  return { interim: '', listening: false }
}
