import { NextRequest } from 'next/server'

const BASE_URL_ENV_KEYS = ['PUBLIC_BASE_URL', 'APP_BASE_URL', 'NEXT_PUBLIC_APP_URL'] as const

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  return `https://${trimmed}`
}

function getConfiguredBaseUrl(): string | null {
  for (const key of BASE_URL_ENV_KEYS) {
    const value = process.env[key]
    if (!value?.trim()) continue

    const normalized = normalizeBaseUrl(value)
    if (!normalized) continue

    try {
      const url = new URL(normalized)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return `${url.protocol}//${url.host}`
      }
    } catch {
      // Ignore invalid configured URLs and continue to the next option.
    }
  }

  const vercelProductionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
  if (vercelProductionHost) {
    return `https://${vercelProductionHost}`
  }

  return null
}

export function getPublicBaseUrl(request: NextRequest): URL {
  const configured = getConfiguredBaseUrl()
  if (configured) {
    return new URL(configured)
  }

  const forwardedProto = request.headers.get('x-forwarded-proto')?.trim()
  const forwardedHost =
    request.headers.get('x-forwarded-host')?.trim() || request.headers.get('host')?.trim()

  if (forwardedHost) {
    const proto = forwardedProto || 'https'
    return new URL(`${proto}://${forwardedHost}`)
  }

  const parsed = new URL(request.url)
  return new URL(`${parsed.protocol}//${parsed.host}`)
}

