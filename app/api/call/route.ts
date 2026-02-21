import { NextRequest, NextResponse } from 'next/server'
import { isValidE164 } from '@/lib/phone'
import { getClientIp, takeCooldown, takeRateLimit } from '@/lib/rate-limit'
import { createAdminClient } from '@/lib/supabase/admin'

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

    return NextResponse.json({
      ok: true,
      callId: data.id,
      status: data.status || 'queued',
    })
  } catch {
    return NextResponse.json(
      { ok: false, error: 'An unexpected error occurred. Please try again.' },
      { status: 500 }
    )
  }
}
