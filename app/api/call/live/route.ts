import { NextRequest, NextResponse } from 'next/server'
import { getSessionSnapshot } from '@/lib/live-call-session'

export function GET(request: NextRequest) {
  const callId = request.nextUrl.searchParams.get('callId')
  const slug = request.nextUrl.searchParams.get('slug')

  if (!callId || !slug) {
    return NextResponse.json(
      { ok: false, error: 'callId and slug are required.' },
      { status: 400 }
    )
  }

  const session = getSessionSnapshot(callId, slug)

  if (!session) {
    return NextResponse.json(
      { ok: false, error: 'Live call session not found.' },
      {
        status: 404,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    )
  }

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
