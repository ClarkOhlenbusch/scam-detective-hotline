import {
  CoachingAdvice,
  LiveSessionSnapshot,
  SessionStatus,
  TranscriptChunk,
  TranscriptSpeaker,
  createDefaultAdvice,
  isTerminalStatus,
  normalizeSessionStatus,
} from '@/lib/live-types'
import { generateLiveAdvice } from '@/lib/live-coach'

type LiveSessionState = {
  callId: string
  slug: string
  status: SessionStatus
  assistantMuted: boolean
  analyzing: boolean
  pendingRun: boolean
  lastError: string | null
  lastAnalyzedCount: number
  version: number
  createdAt: number
  updatedAt: number
  transcript: TranscriptChunk[]
  advice: CoachingAdvice
  analysisTimer: ReturnType<typeof setTimeout> | null
}

type SessionStore = {
  sessions: Map<string, LiveSessionState>
  lastPruneAt: number
}

const SESSION_TTL_MS = 4 * 60 * 60 * 1000
const MAX_TRANSCRIPT_CHUNKS = 220
const ANALYSIS_DEBOUNCE_MS = 700
const PRUNE_INTERVAL_MS = 60_000

function getStore(): SessionStore {
  const liveStore = globalThis as typeof globalThis & {
    __liveCallStore?: SessionStore
  }

  if (!liveStore.__liveCallStore) {
    liveStore.__liveCallStore = {
      sessions: new Map(),
      lastPruneAt: Date.now(),
    }
  }

  return liveStore.__liveCallStore
}

function pruneExpiredSessions(now: number) {
  const store = getStore()

  if (now - store.lastPruneAt < PRUNE_INTERVAL_MS) return

  for (const [callId, session] of store.sessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      if (session.analysisTimer) {
        clearTimeout(session.analysisTimer)
      }
      store.sessions.delete(callId)
    }
  }

  store.lastPruneAt = now
}

function bumpVersion(session: LiveSessionState) {
  session.version += 1
  session.updatedAt = Date.now()
}

function ensureSession(callId: string, slug = 'unknown'): LiveSessionState {
  const store = getStore()
  pruneExpiredSessions(Date.now())

  const existing = store.sessions.get(callId)
  if (existing) {
    if (existing.slug === 'unknown' && slug !== 'unknown') {
      existing.slug = slug
      bumpVersion(existing)
    }
    return existing
  }

  const now = Date.now()
  const created: LiveSessionState = {
    callId,
    slug,
    status: 'queued',
    assistantMuted: false,
    analyzing: false,
    pendingRun: false,
    lastError: null,
    lastAnalyzedCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    transcript: [],
    advice: createDefaultAdvice(),
    analysisTimer: null,
  }

  store.sessions.set(callId, created)
  return created
}

function scheduleAnalysis(callId: string) {
  const store = getStore()
  const session = store.sessions.get(callId)
  if (!session) return

  session.pendingRun = true

  if (session.analysisTimer) {
    clearTimeout(session.analysisTimer)
  }

  session.analysisTimer = setTimeout(() => {
    void runAnalysis(callId)
  }, ANALYSIS_DEBOUNCE_MS)
}

async function runAnalysis(callId: string) {
  const store = getStore()
  const session = store.sessions.get(callId)

  if (!session) return
  if (session.analyzing) return

  session.analysisTimer = null

  if (session.transcript.length === 0) {
    session.pendingRun = false
    return
  }

  if (session.lastAnalyzedCount >= session.transcript.length && !session.pendingRun) {
    return
  }

  session.analyzing = true
  session.pendingRun = false
  bumpVersion(session)

  try {
    const advice = await generateLiveAdvice({
      transcript: session.transcript,
      previousAdvice: session.advice,
    })

    const latest = store.sessions.get(callId)
    if (!latest) return

    latest.advice = advice
    latest.lastError = null
    latest.lastAnalyzedCount = latest.transcript.length
    latest.analyzing = false
    bumpVersion(latest)

    if (latest.lastAnalyzedCount < latest.transcript.length && !isTerminalStatus(latest.status)) {
      scheduleAnalysis(callId)
    }
  } catch {
    const latest = store.sessions.get(callId)
    if (!latest) return

    latest.lastError = 'Live analysis is delayed. Keep verifying through official channels.'
    latest.analyzing = false
    bumpVersion(latest)

    if (!isTerminalStatus(latest.status)) {
      scheduleAnalysis(callId)
    }
  }
}

function normalizeSpeaker(speaker: TranscriptSpeaker): TranscriptSpeaker {
  if (speaker === 'caller' || speaker === 'other' || speaker === 'assistant') {
    return speaker
  }

  return 'unknown'
}

export function createCallSession(params: {
  callId: string
  slug: string
  status?: string | null
}) {
  const session = ensureSession(params.callId, params.slug)

  if (params.status) {
    session.status = normalizeSessionStatus(params.status)
  }

  bumpVersion(session)
}

export function setCallStatus(callId: string, rawStatus: string | undefined | null) {
  const session = ensureSession(callId)
  const nextStatus = normalizeSessionStatus(rawStatus)

  if (session.status !== nextStatus) {
    session.status = nextStatus
    bumpVersion(session)
  }
}

export function setCallError(callId: string, error: string) {
  const session = ensureSession(callId)
  session.lastError = error
  session.status = 'failed'
  bumpVersion(session)
}

export function setAssistantMuted(callId: string, muted = true) {
  const session = ensureSession(callId)

  if (session.assistantMuted === muted) {
    return
  }

  session.assistantMuted = muted
  bumpVersion(session)
}

export function isAssistantMuted(callId: string): boolean {
  const store = getStore()
  return store.sessions.get(callId)?.assistantMuted ?? false
}

export function appendTranscriptChunk(params: {
  callId: string
  slug?: string
  speaker: TranscriptSpeaker
  text: string
  timestamp?: number
  isFinal?: boolean
}) {
  const content = params.text.trim()
  if (!content) return

  const session = ensureSession(params.callId, params.slug)

  if (params.isFinal === false) {
    return
  }

  const speaker = normalizeSpeaker(params.speaker)
  const now = params.timestamp ?? Date.now()

  const lastEntry = session.transcript[session.transcript.length - 1]
  if (lastEntry && lastEntry.speaker === speaker && lastEntry.text === content) {
    return
  }

  session.transcript.push({
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    speaker,
    text: content,
    timestamp: now,
  })

  if (session.transcript.length > MAX_TRANSCRIPT_CHUNKS) {
    session.transcript.shift()
  }

  bumpVersion(session)

  if (!isTerminalStatus(session.status)) {
    scheduleAnalysis(params.callId)
  }
}

export function getSessionSnapshot(callId: string, slug?: string): LiveSessionSnapshot | null {
  const store = getStore()
  pruneExpiredSessions(Date.now())

  const session = store.sessions.get(callId)
  if (!session) return null
  if (slug && session.slug !== slug) return null

  return {
    callId: session.callId,
    slug: session.slug,
    status: session.status,
    assistantMuted: session.assistantMuted,
    analyzing: session.analyzing,
    lastError: session.lastError,
    updatedAt: session.updatedAt,
    version: session.version,
    advice: session.advice,
    transcript: session.transcript.slice(-8),
  }
}
