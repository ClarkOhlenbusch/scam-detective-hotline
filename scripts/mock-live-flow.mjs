#!/usr/bin/env node

import { setTimeout as sleep } from 'node:timers/promises'

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3000'
const webhookSecret = process.env.VAPI_WEBHOOK_SECRET || ''

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

async function postWebhook(payload) {
  const headers = {
    'Content-Type': 'application/json',
  }

  if (webhookSecret) {
    headers['x-vapi-secret'] = webhookSecret
  }

  const response = await fetch(`${baseUrl}/api/vapi/webhook`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  const data = await readJson(response, '/api/vapi/webhook')
  invariant(response.ok && data.ok, `Webhook rejected (${response.status}): ${JSON.stringify(data)}`)
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

  const callId = `mock-${Date.now()}`

  await postWebhook({
    type: 'status-update',
    call: {
      id: callId,
      status: 'in-progress',
      metadata: { slug },
    },
  })

  await postWebhook({
    metadata: { slug },
    message: {
      type: 'transcript',
      callId,
      transcriptType: 'final',
      role: 'other',
      transcript:
        'This is urgent. You must buy gift cards now or your account will be frozen. Share your OTP code immediately.',
    },
  })

  await postWebhook({
    metadata: { slug },
    message: {
      type: 'transcript',
      callId,
      transcriptType: 'final',
      role: 'caller',
      transcript: 'I will call your official number directly before doing anything.',
    },
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

  await postWebhook({
    type: 'status-update',
    call: {
      id: callId,
      status: 'ended',
      metadata: { slug },
    },
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
