import { NextRequest, NextResponse } from 'next/server'
import {
  appendTranscriptChunk,
  createCallSession,
  isAssistantMuted,
  setAssistantMuted,
  setCallError,
  setCallStatus,
} from '@/lib/live-call-session'
import { parseVapiEvent } from '@/lib/vapi-events'

export const runtime = 'nodejs'

function hasValidWebhookSecret(request: NextRequest): boolean {
  const configuredSecret = process.env.VAPI_WEBHOOK_SECRET

  if (!configuredSecret) return true

  const headerSecret = request.headers.get('x-vapi-secret')
  if (headerSecret && headerSecret === configuredSecret) {
    return true
  }

  const authorization = request.headers.get('authorization')
  if (authorization === `Bearer ${configuredSecret}`) {
    return true
  }

  return false
}

async function muteAssistant(controlUrl: string): Promise<boolean> {
  const payload = JSON.stringify({ control: 'mute-assistant' })

  const response = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(5_000),
    body: payload,
  })

  if (response.ok) {
    return true
  }

  const vapiKey = process.env.VAPI_PRIVATE_KEY
  if (!vapiKey) {
    return false
  }

  const retry = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${vapiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(5_000),
    body: payload,
  })

  return retry.ok
}

export async function POST(request: NextRequest) {
  if (!hasValidWebhookSecret(request)) {
    return NextResponse.json(
      { ok: false, error: 'Invalid webhook secret.' },
      { status: 401 }
    )
  }

  let body: unknown

  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON payload.' },
      { status: 400 }
    )
  }

  const event = parseVapiEvent(body)

  if (!event.callId) {
    return NextResponse.json({ ok: true })
  }

  createCallSession({
    callId: event.callId,
    slug: event.slug ?? 'unknown',
    status: event.status,
  })

  if (event.status) {
    setCallStatus(event.callId, event.status)
  }

  if (event.error) {
    setCallError(event.callId, event.error)
  }

  if (event.transcript?.text) {
    appendTranscriptChunk({
      callId: event.callId,
      slug: event.slug ?? undefined,
      speaker: event.transcript.speaker,
      text: event.transcript.text,
      isFinal: event.transcript.isFinal,
    })
  }

  if (event.controlUrl && !isAssistantMuted(event.callId)) {
    const muted = await muteAssistant(event.controlUrl).catch(() => false)
    if (muted) {
      setAssistantMuted(event.callId, true)
    }
  }

  return NextResponse.json({ ok: true })
}
