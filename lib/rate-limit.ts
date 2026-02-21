import { NextRequest } from 'next/server'

type WindowBucket = {
  count: number
  resetAt: number
}

type RateLimitState = {
  buckets: Map<string, WindowBucket>
  cooldowns: Map<string, number>
  lastPruneAt: number
}

const PRUNE_INTERVAL_MS = 60_000

function getState(): RateLimitState {
  const globalRateLimit = globalThis as typeof globalThis & {
    __demoRateLimitState?: RateLimitState
  }

  if (!globalRateLimit.__demoRateLimitState) {
    globalRateLimit.__demoRateLimitState = {
      buckets: new Map(),
      cooldowns: new Map(),
      lastPruneAt: Date.now(),
    }
  }

  return globalRateLimit.__demoRateLimitState
}

function pruneExpired(state: RateLimitState, now: number) {
  if (now - state.lastPruneAt < PRUNE_INTERVAL_MS) return

  for (const [key, bucket] of state.buckets.entries()) {
    if (bucket.resetAt <= now) {
      state.buckets.delete(key)
    }
  }

  for (const [key, readyAt] of state.cooldowns.entries()) {
    if (readyAt <= now) {
      state.cooldowns.delete(key)
    }
  }

  state.lastPruneAt = now
}

export function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) {
    const client = forwardedFor.split(',')[0]?.trim()
    if (client) return client
  }

  const realIp = request.headers.get('x-real-ip')?.trim()
  return realIp || 'unknown'
}

export function takeRateLimit(key: string, limit: number, windowMs: number): boolean {
  const state = getState()
  const now = Date.now()
  pruneExpired(state, now)

  const bucket = state.buckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    state.buckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }

  if (bucket.count >= limit) {
    return false
  }

  bucket.count += 1
  return true
}

export function takeCooldown(key: string, cooldownMs: number): number {
  const state = getState()
  const now = Date.now()
  pruneExpired(state, now)

  const readyAt = state.cooldowns.get(key) ?? 0
  if (readyAt > now) {
    return Math.ceil((readyAt - now) / 1000)
  }

  state.cooldowns.set(key, now + cooldownMs)
  return 0
}
