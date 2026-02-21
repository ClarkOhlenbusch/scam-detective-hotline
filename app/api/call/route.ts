import { NextRequest, NextResponse } from 'next/server'
import { isValidE164 } from '@/lib/phone'
import { getClientIp, takeCooldown, takeRateLimit } from '@/lib/rate-limit'
import { createAdminClient } from '@/lib/supabase/admin'
import { createCallSession } from '@/lib/live-call-session'

async function tryMuteAssistant(controlUrl: string, vapiKey: string) {
  const payload = JSON.stringify({ control: 'mute-assistant' })

  const response = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: payload,
    signal: AbortSignal.timeout(5_000),
  })

  if (response.ok) {
    return true
  }

  const retry = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${vapiKey}`,
      'Content-Type': 'application/json',
    },
    body: payload,
    signal: AbortSignal.timeout(5_000),
  })

  return retry.ok
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { slug } = body

    if (!slug || typeof slug !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'Tenant slug is required.' },
        { status: 400 }
      )
    }

    const ip = getClientIp(request)
    if (!takeRateLimit(`call:ip:${ip}`, 5, 60_000)) {
      return NextResponse.json(
        { ok: false, error: 'Too many requests. Please wait a minute and try again.' },
        { status: 429 }
      )
    }

    const remainingSeconds = takeCooldown(`call:slug:${slug}`, 30_000)
    if (remainingSeconds > 0) {
      return NextResponse.json(
        { ok: false, error: `A call was just placed. Try again in about ${remainingSeconds}s.` },
        { status: 429 }
      )
    }

    // Look up phone number from the tenant record
    const supabase = createAdminClient()
    const { data: tenant, error: dbError } = await supabase
      .from('tenants')
      .select('phone_number')
      .eq('slug', slug)
      .single()

    if (dbError || !tenant) {
      return NextResponse.json(
        { ok: false, error: 'Tenant not found.' },
        { status: 404 }
      )
    }

    const phoneNumber = tenant.phone_number

    if (!phoneNumber || !isValidE164(phoneNumber)) {
      return NextResponse.json(
        { ok: false, error: 'No valid phone number on file. Please set one up first.' },
        { status: 400 }
      )
    }

    const vapiKey = process.env.VAPI_PRIVATE_KEY
    const assistantId = process.env.VAPI_ASSISTANT_ID
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID

    if (!vapiKey || !assistantId || !phoneNumberId) {
      return NextResponse.json(
        { ok: false, error: 'Server configuration error. Contact support.' },
        { status: 500 }
      )
    }

    const serverUrl = new URL('/api/vapi/webhook', request.url).toString()
    const webhookSecret = process.env.VAPI_WEBHOOK_SECRET

    const vapiResponse = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${vapiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        assistantId,
        phoneNumberId,
        customer: { number: phoneNumber },
        assistantOverrides: {
          server: {
            url: serverUrl,
            ...(webhookSecret
              ? {
                  headers: {
                    'x-vapi-secret': webhookSecret,
                  },
                }
              : {}),
          },
          metadata: {
            slug,
          },
        },
      }),
    })

    if (!vapiResponse.ok) {
      const errorData = await vapiResponse.json().catch(() => null)
      const errorMessage =
        errorData?.message || errorData?.error || `Vapi returned status ${vapiResponse.status}`
      return NextResponse.json(
        { ok: false, error: errorMessage },
        { status: vapiResponse.status }
      )
    }

    const data = await vapiResponse.json()
    const callId = typeof data?.id === 'string' ? data.id : null
    const callStatus = typeof data?.status === 'string' ? data.status : 'queued'

    if (!callId) {
      return NextResponse.json(
        { ok: false, error: 'Call was created but no call ID was returned.' },
        { status: 502 }
      )
    }

    createCallSession({
      callId,
      slug,
      status: callStatus,
    })

    const monitorControlUrl =
      typeof data?.monitor?.controlUrl === 'string' ? data.monitor.controlUrl : null

    if (monitorControlUrl) {
      void tryMuteAssistant(monitorControlUrl, vapiKey).catch(() => undefined)
    }

    return NextResponse.json({
      ok: true,
      callId,
      status: callStatus,
    })
  } catch {
    return NextResponse.json(
      { ok: false, error: 'An unexpected error occurred. Please try again.' },
      { status: 500 }
    )
  }
}
