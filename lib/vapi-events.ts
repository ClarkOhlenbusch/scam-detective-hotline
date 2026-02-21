import { TranscriptSpeaker } from '@/lib/live-types'

export type ParsedVapiEvent = {
  callId: string | null
  slug: string | null
  status: string | null
  error: string | null
  controlUrl: string | null
  transcript:
    | {
        text: string
        speaker: TranscriptSpeaker
        isFinal: boolean
      }
    | null
}

type JsonRecord = Record<string, unknown>

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

function mapSpeaker(raw: string | null): TranscriptSpeaker {
  if (!raw) return 'unknown'

  const normalized = raw.toLowerCase()

  if (normalized.includes('assistant') || normalized.includes('bot') || normalized.includes('ai')) {
    return 'assistant'
  }

  if (normalized.includes('user') || normalized.includes('customer') || normalized.includes('caller')) {
    return 'caller'
  }

  if (normalized.includes('other') || normalized.includes('recipient')) {
    return 'other'
  }

  return 'unknown'
}

function extractCallRecord(root: JsonRecord, message: JsonRecord | null): JsonRecord | null {
  const monitor = asRecord(root.monitor)
  return asRecord(root.call) ?? asRecord(message?.call) ?? asRecord(monitor?.call) ?? null
}

export function parseVapiEvent(payload: unknown): ParsedVapiEvent {
  const root = asRecord(payload)

  if (!root) {
    return {
      callId: null,
      slug: null,
      status: null,
      error: null,
      controlUrl: null,
      transcript: null,
    }
  }

  const message = asRecord(root.message)
  const callRecord = extractCallRecord(root, message)
  const callAssistantOverrides = asRecord(callRecord?.assistantOverrides)
  const callAssistantOverridesMetadata = asRecord(callAssistantOverrides?.metadata)
  const callAssistant = asRecord(callRecord?.assistant)
  const callAssistantMetadata = asRecord(callAssistant?.metadata)
  const callMetadata = asRecord(callRecord?.metadata)
  const rootMetadata = asRecord(root.metadata)
  const monitor = asRecord(callRecord?.monitor) ?? asRecord(root.monitor)

  const callId = readString(
    callRecord?.id,
    root.callId,
    message?.callId,
    asRecord(message?.call)?.id,
    root.id,
  )

  const status = readString(
    root.status,
    message?.status,
    callRecord?.status,
    root.type === 'status-update' ? message?.status : null,
  )

  const error = readString(root.error, message?.error)

  const slug = readString(
    callMetadata?.slug,
    callAssistantOverridesMetadata?.slug,
    callAssistantMetadata?.slug,
    rootMetadata?.slug,
  )

  const controlUrl = readString(monitor?.controlUrl)

  const transcriptText = readString(
    message?.transcript,
    message?.text,
    root.transcript,
    root.text,
    message?.content,
  )

  const transcriptType = readString(message?.transcriptType, message?.type, root.type)
  const normalizedTranscriptType = transcriptType?.toLowerCase()
  const looksFinal =
    !normalizedTranscriptType ||
    normalizedTranscriptType.includes('final') ||
    normalizedTranscriptType === 'transcript'

  const speaker = mapSpeaker(readString(message?.role, message?.speaker, root.role, root.speaker))

  return {
    callId,
    slug,
    status,
    error,
    controlUrl,
    transcript: transcriptText
      ? {
          text: transcriptText,
          speaker,
          isFinal: looksFinal,
        }
      : null,
  }
}
