import { NextRequest, NextResponse } from 'next/server'
import { isValidE164 } from '@/lib/phone'
import { getClientIp, takeRateLimit } from '@/lib/rate-limit'
import { createAdminClient } from '@/lib/supabase/admin'

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { slug, phoneNumber } = body

    if (!slug || typeof slug !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'Tenant slug is required.' },
        { status: 400 }
      )
    }

    if (!phoneNumber || typeof phoneNumber !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'Phone number is required.' },
        { status: 400 }
      )
    }

    if (!isValidE164(phoneNumber)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid phone number format. Use E.164 format (e.g. +14155552671).' },
        { status: 400 }
      )
    }

    const ip = getClientIp(request)
    if (!takeRateLimit(`tenant-phone:ip:${ip}`, 20, 10 * 60_000)) {
      return NextResponse.json(
        { ok: false, error: 'Too many update attempts. Please wait a few minutes.' },
        { status: 429 }
      )
    }

    const supabase = createAdminClient()

    const { data: tenant, error: selectError } = await supabase
      .from('tenants')
      .select('phone_number')
      .eq('slug', slug)
      .single()

    if (selectError || !tenant) {
      return NextResponse.json(
        { ok: false, error: 'Tenant not found.' },
        { status: 404 }
      )
    }

    if (tenant.phone_number === phoneNumber) {
      return NextResponse.json({ ok: true })
    }

    const overrideToken = process.env.TENANT_ADMIN_OVERRIDE_TOKEN
    const providedOverride = request.headers.get('x-admin-override-token')
    const hasValidOverride = !!overrideToken && providedOverride === overrideToken

    if (tenant.phone_number && !hasValidOverride) {
      return NextResponse.json(
        { ok: false, error: 'Phone number is already configured. Contact support to change it.' },
        { status: 409 }
      )
    }

    const { error } = await supabase
      .from('tenants')
      .update({ phone_number: phoneNumber, updated_at: new Date().toISOString() })
      .eq('slug', slug)

    if (error) {
      return NextResponse.json(
        { ok: false, error: 'Failed to save phone number.' },
        { status: 500 }
      )
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json(
      { ok: false, error: 'An unexpected error occurred.' },
      { status: 500 }
    )
  }
}
