// Students join a lecture with the code shown on the teacher's projected screen.
// /join/:code (from a link or QR code) joins straight away. Phone-first; no links to teacher pages.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { findSessionByCode, JOIN_CODE_LENGTH, normalizeJoinCode } from '../lib/joinCode'
import '../styles/p4.css'
import '../styles/student.css'

type Status = 'idle' | 'joining' | 'not-found' | 'failed'

const MESSAGES: Partial<Record<Status, string>> = {
  'not-found': 'No lecture with that code. Check the board and try again.',
  failed: 'Couldn’t check that code. Check your connection and try again.',
}

export default function Join() {
  const { code: codeFromLink = '' } = useParams()
  const navigate = useNavigate()
  const [code, setCode] = useState(() => normalizeJoinCode(codeFromLink))
  const [status, setStatus] = useState<Status>('idle')
  const busy = useRef(false)

  const join = async (value: string) => {
    if (busy.current || value.length !== JOIN_CODE_LENGTH) return
    busy.current = true
    setStatus('joining')
    try {
      const target = await findSessionByCode(value)
      if (target) navigate(`/live/${target.sessionId}`, { replace: true })
      else setStatus('not-found')
    } catch (e) {
      console.warn('Join code lookup failed:', e)
      setStatus('failed')
    } finally {
      busy.current = false
    }
  }

  // /join/:code joins straight away.
  useEffect(() => {
    const fromLink = normalizeJoinCode(codeFromLink)
    if (!fromLink) return
    setCode(fromLink)
    void join(fromLink)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeFromLink])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void join(code)
  }

  const message = MESSAGES[status]

  return (
    <div className="p4 stu stu-join">
      <form className="stu-join-card" onSubmit={submit}>
        <span className="p4-badge">Join a lecture</span>
        <h1 id="join-heading">Enter the code on the board</h1>
        <input
          className="stu-code-input"
          aria-labelledby="join-heading"
          aria-describedby={message ? 'join-error' : undefined}
          aria-invalid={status === 'not-found' || undefined}
          value={code}
          onChange={(e) => {
            setCode(normalizeJoinCode(e.target.value))
            if (status !== 'joining') setStatus('idle')
          }}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          enterKeyHint="go"
        />
        {message && (
          <p id="join-error" className="stu-error" role="alert">
            {message}
          </p>
        )}
        <button
          type="submit"
          className="p4-btn solid stu-join-btn"
          disabled={code.length !== JOIN_CODE_LENGTH || status === 'joining'}
        >
          {status === 'joining' ? 'Joining…' : 'Join'}
        </button>
      </form>
    </div>
  )
}
