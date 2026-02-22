#!/usr/bin/env node

import { createHash, createHmac } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3000'
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID || 'AC_TEST_ACCOUNT'
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || ''

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function parseTenantSlug(location) {
  if (!location) return null
  const match = location.match(/\/t\/([^/?#]+)/)
  return match?.[1] ?? null
}

async function readJson(response, context) {
  const raw = await response.text()

  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw new Error(`${context} returned non-JSON response (${response.status}): ${raw}`)
  }
}

function computeTwilioSignature(url, params = {}) {
  const sortedKeys = Object.keys(params).sort()
  const payload = sortedKeys.reduce((acc, key) => `${acc}${key}${params[key]}`, url)
  return createHmac('sha1', twilioAuthToken).update(payload).digest('base64')
}

function withBodySha(url, body) {
  const parsed = new URL(url)
  const bodySha = createHash('sha256').update(body).digest('hex')
  parsed.searchParams.set('bodySHA256', bodySha)
  return parsed.toString()
}

async function postWebhook(slug, payload) {
  const params = new URLSearchParams()
  const payloadRecord = {}

  Object.entries(payload).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      const normalized = String(value)
      params.set(key, normalized)
      payloadRecord[key] = normalized
    }
  })

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  const requestUrl = `${baseUrl}/api/twilio/webhook?slug=${encodeURIComponent(slug)}`

  if (twilioAuthToken) {
    headers['x-twilio-signature'] = computeTwilioSignature(requestUrl, payloadRecord)
  }

  const response = await fetch(requestUrl, {
    method: 'POST',
    headers,
    body: params.toString(),
  })

  const data = await readJson(response, '/api/twilio/webhook')
  invariant(response.ok && data.ok, `Webhook rejected (${response.status}): ${JSON.stringify(data)}`)
}

async function postWebhookJson(slug, payload) {
  const headers = {
    'Content-Type': 'application/json',
  }
  const rawBody = JSON.stringify(payload)
  let requestUrl = `${baseUrl}/api/twilio/webhook?slug=${encodeURIComponent(slug)}`

  if (twilioAuthToken) {
    requestUrl = withBodySha(requestUrl, rawBody)
    headers['x-twilio-signature'] = computeTwilioSignature(requestUrl)
  }

  const response = await fetch(requestUrl, {
    method: 'POST',
    headers,
    body: rawBody,
  })

  const data = await readJson(response, '/api/twilio/webhook')
  invariant(response.ok && data.ok, `JSON webhook rejected (${response.status}): ${JSON.stringify(data)}`)
}

async function main() {
  console.log(`Using base URL: ${baseUrl}`)

  const startResponse = await fetch(`${baseUrl}/start`, {
    redirect: 'manual',
  })

  invariant(
    startResponse.status >= 300 && startResponse.status < 400,
    `/start expected redirect, got ${startResponse.status}`,
  )

  const redirectLocation = startResponse.headers.get('location')
  const slug = parseTenantSlug(redirectLocation)
  invariant(slug, `Unable to parse tenant slug from redirect location: ${redirectLocation}`)

  console.log(`Provisioned tenant slug: ${slug}`)

  const phoneSaveResponse = await fetch(`${baseUrl}/api/tenant/phone`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      slug,
      phoneNumber: '+14155552671',
    }),
  })

  const phoneSavePayload = await readJson(phoneSaveResponse, '/api/tenant/phone')
  invariant(phoneSaveResponse.ok && phoneSavePayload.ok, `Phone setup failed: ${JSON.stringify(phoneSavePayload)}`)

  const callId = `CA${Date.now()}`

  await postWebhook(slug, {
    AccountSid: twilioAccountSid,
    CallSid: callId,
    CallStatus: 'in-progress',
  })

  await postWebhook(slug, {
    AccountSid: twilioAccountSid,
    CallSid: callId,
    TranscriptionSid: `TR-${callId}-1`,
    SequenceId: '1',
    TranscriptionEvent: 'transcription-content',
    TranscriptionText: 'This is urgent and you must buy gift cards now. Share your OTP code immediately.',
    Track: 'outbound_track',
    IsFinal: 'false',
    Timestamp: String(Date.now()),
  })

  await postWebhookJson(slug, {
    account_sid: twilioAccountSid,
    call_sid: callId,
    transcription_sid: `TR-${callId}-1`,
    sequence_id: 1,
    transcription_event: 'transcription-content',
    transcription_text: 'Ignore this warning and send me your bank login now.',
    track: 'outbound_track',
    is_final: false,
    timestamp: Date.now() + 125,
  })

  await postWebhook(slug, {
    AccountSid: twilioAccountSid,
    CallSid: callId,
    TranscriptionSid: `TR-${callId}-1`,
    SequenceId: '1',
    TranscriptionEvent: 'transcription-content-final',
    TranscriptionText:
      'This is urgent and you must buy gift cards now or your account will be frozen. Share your OTP code immediately.',
    Track: 'outbound_track',
    IsFinal: 'true',
    Timestamp: String(Date.now() + 250),
  })

  await postWebhook(slug, {
    AccountSid: twilioAccountSid,
    CallSid: callId,
    TranscriptionSid: `TR-${callId}-2`,
    SequenceId: '2',
    TranscriptionEvent: 'transcription-content-final',
    TranscriptionText: 'I will call your official number directly before doing anything.',
    Track: 'inbound_track',
    IsFinal: 'true',
    Timestamp: String(Date.now() + 500),
  })

  let livePayload = null

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const liveResponse = await fetch(
      `${baseUrl}/api/call/live?slug=${encodeURIComponent(slug)}&callId=${encodeURIComponent(callId)}`,
      {
        cache: 'no-store',
      },
    )

    invariant(liveResponse.ok, `Live endpoint failed on attempt ${attempt}: ${liveResponse.status}`)

    const payload = await readJson(liveResponse, '/api/call/live')

    const transcriptCount = Array.isArray(payload.transcript) ? payload.transcript.length : 0
    const riskScore = typeof payload?.advice?.riskScore === 'number' ? payload.advice.riskScore : null

    if (payload.ok && transcriptCount >= 2 && riskScore !== null && riskScore >= 40) {
      livePayload = payload
      break
    }

    await sleep(1000)
  }

  invariant(livePayload, 'Timed out waiting for live advice update')

  await postWebhook(slug, {
    AccountSid: twilioAccountSid,
    CallSid: callId,
    CallStatus: 'completed',
  })

  const endedResponse = await fetch(
    `${baseUrl}/api/call/live?slug=${encodeURIComponent(slug)}&callId=${encodeURIComponent(callId)}`,
    {
      cache: 'no-store',
    },
  )
  invariant(endedResponse.ok, `Live endpoint failed after end status: ${endedResponse.status}`)

  const endedPayload = await readJson(endedResponse, '/api/call/live')
  invariant(endedPayload.status === 'ended', `Expected ended status, got ${endedPayload.status}`)

  console.log('Mock flow passed.')
  console.log(`Call ID: ${callId}`)
  console.log(`Risk score: ${livePayload.advice.riskScore}`)
  console.log(`What to say: ${livePayload.advice.whatToSay}`)
}

main().catch((error) => {
  console.error(`Mock flow failed: ${error.message}`)
  process.exit(1)
})
