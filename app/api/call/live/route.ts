import { NextRequest, NextResponse } from 'next/server'
import { generateLiveAdvice } from '@/lib/live-coach'
import { getSessionSnapshot } from '@/lib/live-call-session'
import {
  CoachingAdvice,
  LiveSessionSnapshot,
  TranscriptChunk,
  TranscriptSpeaker,
  createDefaultAdvice,
  isTerminalStatus,
  normalizeSessionStatus,
} from '@/lib/live-types'
import { muteAssistantByControlUrl } from '@/lib/vapi-control'

export const runtime = 'nodejs'

type JsonRecord = Record<string, unknown>

type AdviceCacheEntry = {
  key: string
  advice: CoachingAdvice
  updatedAt: number
}

type LiveApiCache = {
  adviceByCallId: Map<string, AdviceCacheEntry>
  mutedByCallId: Map<string, number>
  lastPruneAt: number
}

const CACHE_PRUNE_INTERVAL_MS = 60_000
const ADVICE_CACHE_TTL_MS = 5 * 60 * 1000
const MUTE_CACHE_TTL_MS = 2 * 60 * 60 * 1000

function getCache(): LiveApiCache {
  const globalCache = globalThis as typeof globalThis & {
    __liveApiCache?: LiveApiCache
  }

  if (!globalCache.__liveApiCache) {
    globalCache.__liveApiCache = {
      adviceByCallId: new Map(),
      mutedByCallId: new Map(),
      lastPruneAt: Date.now(),
    }
  }

  return globalCache.__liveApiCache
}

function pruneCache(now = Date.now()) {
  const cache = getCache()

  if (now - cache.lastPruneAt < CACHE_PRUNE_INTERVAL_MS) {
    return
  }

  for (const [callId, entry] of cache.adviceByCallId.entries()) {
    if (now - entry.updatedAt > ADVICE_CACHE_TTL_MS) {
      cache.adviceByCallId.delete(callId)
    }
  }

  for (const [callId, updatedAt] of cache.mutedByCallId.entries()) {
    if (now - updatedAt > MUTE_CACHE_TTL_MS) {
      cache.mutedByCallId.delete(callId)
    }
  }

  cache.lastPruneAt = now
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as JsonRecord
}

function readString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) return trimmed
    }
  }
  return null
}

function roleToSpeaker(role: string | null): TranscriptSpeaker {
  if (!role) return 'unknown'

  const normalized = role.toLowerCase()

  if (normalized.includes('assistant') || normalized.includes('bot') || normalized.includes('ai')) {
    return 'assistant'
  }

  if (normalized.includes('user') || normalized.includes('caller') || normalized.includes('customer')) {
    return 'caller'
  }

  if (normalized.includes('other') || normalized.includes('recipient')) {
    return 'other'
  }

  return 'unknown'
}

function extractCallSlug(callRecord: JsonRecord): string | null {
  const assistantOverrides = asRecord(callRecord.assistantOverrides)
  const assistantOverridesMetadata = asRecord(assistantOverrides?.metadata)
  const assistant = asRecord(callRecord.assistant)
  const assistantMetadata = asRecord(assistant?.metadata)
  const callMetadata = asRecord(callRecord.metadata)

  return readString(
    assistantOverridesMetadata?.slug,
    assistantMetadata?.slug,
    callMetadata?.slug,
  )
}

function extractTranscript(callRecord: JsonRecord): TranscriptChunk[] {
  const messages = Array.isArray(callRecord.messages) ? callRecord.messages : []

  const transcript: TranscriptChunk[] = []

  messages.forEach((message, index) => {
    const record = asRecord(message)
    if (!record) return

    const text = readString(record.message)
    if (!text) return

    const role = readString(record.role)
    const speaker = roleToSpeaker(role)

    if (speaker === 'assistant') {
      // The coach should focus on human call content only.
      return
    }

    const time = typeof record.time === 'number' ? Math.round(record.time) : Date.now()

    transcript.push({
      id: `${time}-${index}`,
      speaker,
      text,
      timestamp: time,
    })
  })

  if (transcript.length <= 120) return transcript
  return transcript.slice(-120)
}

function transcriptKey(transcript: TranscriptChunk[]): string {
  const last = transcript[transcript.length - 1]
  if (!last) return '0:none:0'
  return `${transcript.length}:${last.timestamp}:${last.speaker}:${last.text}`
}

function buildPlaceholder(callId: string, slug: string, note: string | null): LiveSessionSnapshot {
  const now = Date.now()

  return {
    callId,
    slug,
    status: 'queued',
    assistantMuted: false,
    analyzing: false,
    lastError: note,
    updatedAt: now,
    version: 0,
    advice: createDefaultAdvice(),
    transcript: [],
  }
}

async function fetchVapiCall(callId: string, vapiKey: string) {
  const response = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${vapiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(7_000),
  })

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      payload: await response.json().catch(() => null),
    }
  }

  return {
    ok: true,
    status: response.status,
    payload: await response.json().catch(() => null),
  }
}

async function resolveAdvice(callId: string, transcript: TranscriptChunk[]): Promise<CoachingAdvice> {
  if (transcript.length === 0) {
    return createDefaultAdvice()
  }

  pruneCache()
  const now = Date.now()
  const key = transcriptKey(transcript)
  const cache = getCache()
  const cached = cache.adviceByCallId.get(callId)

  if (cached && cached.key === key && now - cached.updatedAt <= ADVICE_CACHE_TTL_MS) {
    return cached.advice
  }

  const advice = await generateLiveAdvice({ transcript }).catch(() => createDefaultAdvice())

  cache.adviceByCallId.set(callId, {
    key,
    advice,
    updatedAt: now,
  })

  return advice
}

async function ensureMuted(callId: string, controlUrl: string, vapiKey: string): Promise<boolean> {
  pruneCache()
  const cache = getCache()

  if (cache.mutedByCallId.has(callId)) {
    return true
  }

  const muted = await muteAssistantByControlUrl(controlUrl, vapiKey).catch(() => false)

  if (muted) {
    cache.mutedByCallId.set(callId, Date.now())
  }

  return muted
}

export async function GET(request: NextRequest) {
  const callId = request.nextUrl.searchParams.get('callId')
  const slug = request.nextUrl.searchParams.get('slug')

  if (!callId || !slug) {
    return NextResponse.json(
      { ok: false, error: 'callId and slug are required.' },
      { status: 400 }
    )
  }

  const session = getSessionSnapshot(callId, slug)

  if (session) {
    return NextResponse.json(
      {
        ok: true,
        ...session,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    )
  }

  const vapiKey = process.env.VAPI_PRIVATE_KEY

  if (!vapiKey) {
    return NextResponse.json(
      {
        ok: true,
        ...buildPlaceholder(callId, slug, 'Waiting for Vapi telemetry.'),
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    )
  }

  const callResult = await fetchVapiCall(callId, vapiKey)

  if (!callResult.ok && callResult.status === 404) {
    return NextResponse.json(
      {
        ok: true,
        ...buildPlaceholder(callId, slug, 'Waiting for call telemetry from Vapi.'),
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    )
  }

  if (!callResult.ok) {
    const errorMessage =
      callResult.payload?.message ||
      callResult.payload?.error ||
      `Failed to load call from Vapi (${callResult.status}).`

    return NextResponse.json(
      {
        ok: false,
        error: errorMessage,
      },
      {
        status: 502,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    )
  }

  const callRecord = asRecord(callResult.payload)

  if (!callRecord) {
    return NextResponse.json(
      {
        ok: true,
        ...buildPlaceholder(callId, slug, 'Call telemetry format was invalid.'),
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    )
  }

  const callSlug = extractCallSlug(callRecord)

  if (callSlug && callSlug !== slug) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Live call session not found for this case.',
      },
      {
        status: 404,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    )
  }

  const status = normalizeSessionStatus(readString(callRecord.status))
  const transcript = extractTranscript(callRecord)
  const advice = await resolveAdvice(callId, transcript)

  const controlUrl = readString(asRecord(callRecord.monitor)?.controlUrl)
  const assistantMuted =
    !!controlUrl && !isTerminalStatus(status)
      ? await ensureMuted(callId, controlUrl, vapiKey)
      : false

  const response: LiveSessionSnapshot = {
    callId,
    slug,
    status,
    assistantMuted,
    analyzing: false,
    lastError: null,
    updatedAt: Date.now(),
    version: 1,
    advice,
    transcript: transcript.slice(-8),
  }

  return NextResponse.json(
    {
      ok: true,
      ...response,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  )
}
