import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

const TENANT_COOKIE = 'tenant_slug'
const TENANT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365
const MAX_PROVISION_ATTEMPTS = 5

function isValidSlug(slug: string) {
  return /^[a-z0-9-]{3,64}$/.test(slug)
}

function generateSlug() {
  return `case-${crypto.randomUUID().slice(0, 8)}`
}

async function findTenantSlug(slug: string) {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('tenants')
    .select('slug')
    .eq('slug', slug)
    .maybeSingle()

  if (error || !data?.slug) {
    return null
  }

  return data.slug
}

async function createTenant() {
  const supabase = createAdminClient()

  for (let i = 0; i < MAX_PROVISION_ATTEMPTS; i += 1) {
    const slug = generateSlug()
    const name = 'Scam Detective Case'

    const { data, error } = await supabase
      .from('tenants')
      .insert({ slug, name })
      .select('slug')
      .single()

    if (!error && data?.slug) {
      return data.slug
    }

    // Duplicate slug collision: retry with a new generated value.
    if (error?.code === '23505') {
      continue
    }

    break
  }

  return null
}

export async function GET(request: NextRequest) {
  const cookieSlug = request.cookies.get(TENANT_COOKIE)?.value

  if (cookieSlug && isValidSlug(cookieSlug)) {
    const existingSlug = await findTenantSlug(cookieSlug)
    if (existingSlug) {
      return NextResponse.redirect(new URL(`/t/${existingSlug}`, request.url))
    }
  }

  const newSlug = await createTenant()
  if (!newSlug) {
    return NextResponse.json(
      { ok: false, error: 'Unable to initialize a case right now. Please refresh.' },
      { status: 500 }
    )
  }

  const response = NextResponse.redirect(new URL(`/t/${newSlug}`, request.url))
  const isSecureRequest = request.nextUrl.protocol === 'https:'
  response.cookies.set({
    name: TENANT_COOKIE,
    value: newSlug,
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest,
    path: '/',
    maxAge: TENANT_COOKIE_MAX_AGE_SECONDS,
  })

  return response
}
