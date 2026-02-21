'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  Loader2,
  Phone,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

type PanelState = 'idle' | 'starting' | 'live' | 'ended' | 'error'
type RiskLevel = 'low' | 'medium' | 'high'

type TranscriptLine = {
  id: string
  speaker: 'caller' | 'other' | 'assistant' | 'unknown'
  text: string
  timestamp: number
}

type LiveAdvice = {
  riskScore: number
  riskLevel: RiskLevel
  feedback: string
  whatToSay: string
  whatToDo: string
  nextSteps: string[]
  confidence: number
  updatedAt: number
}

type LiveSessionPayload = {
  ok: boolean
  status?: string
  assistantMuted?: boolean
  analyzing?: boolean
  lastError?: string | null
  updatedAt?: number
  advice?: LiveAdvice
  transcript?: TranscriptLine[]
  error?: string
}

const STORAGE_KEY_PREFIX = 'live-call:'

function createDefaultAdvice(): LiveAdvice {
  return {
    riskScore: 20,
    riskLevel: 'low',
    feedback: 'Listening for risk signals. Stay calm and ask for verification.',
    whatToSay: 'Can you share your full name, department, and official callback number?',
    whatToDo: 'Do not share one-time codes, account numbers, or payment details.',
    nextSteps: [
      'Ask them to repeat their claim clearly.',
      'Say you will verify using an official number.',
    ],
    confidence: 0.3,
    updatedAt: Date.now(),
  }
}

function isTerminalStatus(status: string): boolean {
  const normalized = status.toLowerCase()
  return (
    normalized.includes('end') ||
    normalized.includes('complete') ||
    normalized.includes('cancel') ||
    normalized.includes('fail') ||
    normalized.includes('error')
  )
}

function formatSpeakerLabel(speaker: TranscriptLine['speaker']): string {
  if (speaker === 'caller') return 'You'
  if (speaker === 'other') return 'Caller'
  if (speaker === 'assistant') return 'Assistant'
  return 'Unknown'
}

function formatStatusLabel(status: string): string {
  const normalized = status.toLowerCase()

  if (normalized.includes('queue')) return 'Queueing call'
  if (normalized.includes('ring')) return 'Ringing'
  if (normalized.includes('in-progress') || normalized.includes('active')) return 'Live'
  if (normalized.includes('end') || normalized.includes('complete')) return 'Call ended'
  if (normalized.includes('fail') || normalized.includes('error') || normalized.includes('busy')) {
    return 'Call failed'
  }

  return 'Connecting'
}

function formatTime(timestamp: number | null): string {
  if (!timestamp) return '--'
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function CasePanel({ slug, maskedPhone }: { slug: string; maskedPhone: string }) {
  const [panelState, setPanelState] = useState<PanelState>('idle')
  const [callId, setCallId] = useState<string | null>(null)
  const [callStatus, setCallStatus] = useState('queued')
  const [assistantMuted, setAssistantMuted] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [caseNote, setCaseNote] = useState('')
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [advice, setAdvice] = useState<LiveAdvice>(createDefaultAdvice())
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])

  const storageKey = `${STORAGE_KEY_PREFIX}${slug}`

  useEffect(() => {
    const existingCallId = window.sessionStorage.getItem(storageKey)

    if (!existingCallId) {
      return
    }

    setCallId(existingCallId)
    setPanelState('live')
    setCaseNote('Reconnected to your active monitor session.')
  }, [storageKey])

  useEffect(() => {
    if (!callId) return
    const activeCallId = callId

    let cancelled = false
    let inFlight = false

    async function pollLiveSession() {
      if (cancelled || inFlight) return
      inFlight = true

      try {
        const res = await fetch(
          `/api/call/live?slug=${encodeURIComponent(slug)}&callId=${encodeURIComponent(activeCallId)}`,
          {
            cache: 'no-store',
          }
        )

        const data: LiveSessionPayload = await res.json()

        if (cancelled) return

        if (!res.ok || !data.ok) {
          if (res.status === 404) {
            setPanelState('error')
            setError('Live session expired. Start a new monitor session.')
            window.sessionStorage.removeItem(storageKey)
          }
          return
        }

        if (typeof data.status === 'string') {
          setCallStatus(data.status)
          if (isTerminalStatus(data.status)) {
            setPanelState('ended')
            window.sessionStorage.removeItem(storageKey)
          } else {
            setPanelState('live')
          }
        }

        setAssistantMuted(Boolean(data.assistantMuted))
        setAnalyzing(Boolean(data.analyzing))

        if (typeof data.updatedAt === 'number') {
          setLastUpdated(data.updatedAt)
        }

        if (data.advice) {
          setAdvice(data.advice)
        }

        if (Array.isArray(data.transcript)) {
          setTranscript(data.transcript)
        }

        if (data.lastError) {
          setCaseNote(data.lastError)
        }
      } catch {
        if (!cancelled) {
          setCaseNote('Live updates paused. Reconnecting...')
        }
      } finally {
        inFlight = false
      }
    }

    void pollLiveSession()
    const timer = window.setInterval(() => {
      void pollLiveSession()
    }, 1200)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [callId, slug, storageKey])

  const riskTheme = useMemo(() => {
    if (advice.riskLevel === 'high') {
      return {
        card: 'border-destructive/40 bg-destructive/10',
        label: 'text-destructive',
        Icon: ShieldAlert,
      }
    }

    if (advice.riskLevel === 'medium') {
      return {
        card: 'border-amber-500/40 bg-amber-500/10',
        label: 'text-amber-500',
        Icon: ShieldQuestion,
      }
    }

    return {
      card: 'border-emerald-500/40 bg-emerald-500/10',
      label: 'text-emerald-500',
      Icon: ShieldCheck,
    }
  }, [advice.riskLevel])

  async function handleStartMonitor() {
    setPanelState('starting')
    setError('')
    setCaseNote('Calling your saved number...')

    try {
      const res = await fetch('/api/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      })

      const data = await res.json()

      if (!res.ok || !data.ok || !data.callId) {
        setPanelState('error')
        setError(data.error || 'Unable to start monitor session. Try again.')
        return
      }

      const nextCallId = String(data.callId)
      setCallId(nextCallId)
      setCallStatus(typeof data.status === 'string' ? data.status : 'queued')
      setPanelState('live')
      setCaseNote('Answer the incoming call. We listen silently and coach you on this screen.')
      window.sessionStorage.setItem(storageKey, nextCallId)
    } catch {
      setPanelState('error')
      setError('Connection failed. Check your network and try again.')
    }
  }

  function resetSession() {
    setPanelState('idle')
    setCallId(null)
    setCallStatus('queued')
    setAssistantMuted(false)
    setAnalyzing(false)
    setCaseNote('')
    setError('')
    setLastUpdated(null)
    setAdvice(createDefaultAdvice())
    setTranscript([])
    window.sessionStorage.removeItem(storageKey)
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-5">
      <div className="flex flex-col items-center gap-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          Protected Number
        </p>
        <p className="font-mono text-lg text-foreground">{maskedPhone}</p>
      </div>

      {panelState === 'idle' && (
        <div className="flex w-full flex-col gap-3">
          <Button
            onClick={handleStartMonitor}
            size="lg"
            className="h-14 w-full bg-primary font-mono text-sm font-semibold uppercase tracking-widest text-primary-foreground hover:bg-primary/90"
          >
            <Phone className="mr-2 h-5 w-5" />
            Start Silent Monitor
          </Button>
          <p className="text-center font-mono text-xs text-muted-foreground">
            We call you, listen silently, and coach you live on this screen.
          </p>
        </div>
      )}

      {panelState === 'starting' && (
        <div className="flex w-full flex-col items-center gap-3 rounded-lg border border-border bg-card px-6 py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="font-mono text-sm uppercase tracking-widest text-muted-foreground">Starting monitor...</p>
          <p className="text-center font-mono text-xs text-muted-foreground">
            Keep this page open while the call connects.
          </p>
        </div>
      )}

      {(panelState === 'live' || panelState === 'ended') && (
        <div className="flex w-full flex-col gap-3">
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Call Status</p>
              <p className="font-mono text-xs uppercase tracking-widest text-foreground">
                {formatStatusLabel(callStatus)}
              </p>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <p className="font-mono text-xs text-muted-foreground">
                Silent mode: {assistantMuted ? 'locked' : 'enabling...'}
              </p>
              <p className="font-mono text-xs text-muted-foreground">Updated {formatTime(lastUpdated)}</p>
            </div>
          </div>

          <div className={`rounded-lg border px-4 py-4 ${riskTheme.card}`}>
            <div className="flex items-center justify-between">
              <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Scam Risk</p>
              <riskTheme.Icon className={`h-4 w-4 ${riskTheme.label}`} />
            </div>
            <div className="mt-2 flex items-end justify-between gap-2">
              <p className={`font-mono text-3xl font-semibold ${riskTheme.label}`}>{advice.riskScore}/100</p>
              <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                {advice.riskLevel}
              </p>
            </div>
            <p className="mt-2 font-mono text-sm text-foreground">{advice.feedback}</p>
          </div>

          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">What To Say</p>
            <p className="mt-2 font-mono text-sm text-foreground">{advice.whatToSay}</p>
          </div>

          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">What To Do</p>
            <p className="mt-2 font-mono text-sm text-foreground">{advice.whatToDo}</p>
          </div>

          {advice.nextSteps.length > 0 && (
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Next Steps</p>
              <div className="mt-2 flex flex-col gap-2">
                {advice.nextSteps.map((item) => (
                  <p key={item} className="font-mono text-xs text-foreground">
                    • {item}
                  </p>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Live Transcript</p>
            <div className="mt-2 flex max-h-36 flex-col gap-2 overflow-y-auto">
              {transcript.length === 0 && (
                <p className="font-mono text-xs text-muted-foreground">Waiting for live transcript...</p>
              )}
              {transcript.map((line) => (
                <p key={line.id} className="font-mono text-xs text-foreground">
                  <span className="text-muted-foreground">{formatSpeakerLabel(line.speaker)}:</span> {line.text}
                </p>
              ))}
            </div>
          </div>

          <Button
            onClick={resetSession}
            variant="outline"
            size="sm"
            className="font-mono text-xs uppercase tracking-widest"
          >
            <RotateCcw className="mr-2 h-3 w-3" />
            New Session
          </Button>
        </div>
      )}

      {panelState === 'error' && (
        <div className="flex w-full flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-8">
          <AlertTriangle className="h-8 w-8 text-destructive" />
          <p className="font-mono text-sm font-semibold uppercase tracking-widest text-destructive">Session Failed</p>
          <p className="text-center font-mono text-sm text-foreground">{error || 'Unable to start session.'}</p>
          <Button
            onClick={handleStartMonitor}
            variant="outline"
            size="sm"
            className="mt-2 font-mono text-xs uppercase tracking-widest"
          >
            <RotateCcw className="mr-2 h-3 w-3" />
            Retry
          </Button>
        </div>
      )}

      {caseNote && panelState !== 'starting' && (
        <div className="w-full rounded-lg border border-border bg-card px-4 py-3">
          <p className="mb-1 font-mono text-xs uppercase tracking-widest text-muted-foreground">Session Note</p>
          <p className="font-mono text-sm text-foreground">{caseNote}</p>
          {analyzing && <p className="mt-2 font-mono text-xs text-muted-foreground">Analyzing latest transcript...</p>}
        </div>
      )}

      <Link
        href={`/t/${slug}/setup`}
        className="font-mono text-xs uppercase tracking-widest text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        Change number
      </Link>
    </div>
  )
}
