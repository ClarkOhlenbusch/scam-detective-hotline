import { z } from 'zod'
import { CoachingAdvice, TranscriptChunk, createDefaultAdvice, getRiskLevel } from '@/lib/live-types'

const parsedAdviceSchema = z.object({
  riskScore: z.number().min(0).max(100),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  feedback: z.string().min(1).max(220),
  whatToSay: z.string().min(1).max(220),
  whatToDo: z.string().min(1).max(220),
  nextSteps: z.array(z.string().min(1).max(120)).max(2).default([]),
  confidence: z.number().min(0).max(1).optional(),
})

const HIGH_RISK_PATTERNS = [
  /gift card/i,
  /wire transfer/i,
  /crypto|bitcoin/i,
  /one[- ]?time pass(code)?|otp|verification code/i,
  /social security|ssn/i,
  /bank account|routing number/i,
  /remote access|screen share|install (this|our) app/i,
  /urgent|immediately|act now|final warning/i,
  /arrest|warrant|lawsuit|jail/i,
]

const MEDIUM_RISK_PATTERNS = [
  /keep this confidential|don't tell/i,
  /suspicious activity/i,
  /refund department|tech support/i,
  /pay now|security hold/i,
  /confirm your identity/i,
]

const RISK_SYSTEM_PROMPT = [
  'You are a real-time anti-scam call coach for older adults.',
  'Input is a running transcript between a caller (user) and another party.',
  'Return JSON only, no markdown.',
  'Keep advice short, concrete, calm, and action-first.',
  'Rules: never advise sharing personal data, passwords, codes, or payments.',
  'Focus: "whatToDo" must be one clear action the user can take right now.',
  '"nextSteps" is action history on screen: include at most 2 short older actions.',
  'Scoring nuance: only raise risk sharply when there is concrete scam evidence.',
  'If evidence is mixed or uncertain, avoid dramatic score jumps and lower confidence.',
  'Output fields:',
  '{',
  '  "riskScore": number 0-100,',
  '  "riskLevel": "low" | "medium" | "high",',
  '  "feedback": short sentence with current risk read,',
  '  "whatToSay": one sentence user can say right now,',
  '  "whatToDo": one sentence action user should take now,',
  '  "nextSteps": array of up to 2 short items,',
  '  "confidence": number 0-1',
  '}',
].join('\n')

export class ModelAdviceError extends Error {
  statusCode: number | null
  retryAfterMs: number | null

  constructor(
    message: string,
    params?: {
      statusCode?: number | null
      retryAfterMs?: number | null
    },
  ) {
    super(message)
    this.name = 'ModelAdviceError'
    this.statusCode = params?.statusCode ?? null
    this.retryAfterMs = params?.retryAfterMs ?? null
  }
}

function getRecentTranscript(transcript: TranscriptChunk[], maxEntries = 40): TranscriptChunk[] {
  if (transcript.length <= maxEntries) return transcript
  return transcript.slice(-maxEntries)
}

function formatTranscriptForModel(transcript: TranscriptChunk[]): string {
  return transcript
    .map((entry) => {
      const speaker = entry.speaker === 'caller' ? 'Caller' : entry.speaker === 'other' ? 'Other party' : entry.speaker
      return `${speaker}: ${entry.text}`
    })
    .join('\n')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function parseJsonObject(text: string): unknown {
  const direct = text.trim()

  if (direct.startsWith('{') && direct.endsWith('}')) {
    return JSON.parse(direct)
  }

  const fencedMatch = direct.match(/```json\s*([\s\S]*?)\s*```/i)
  if (fencedMatch?.[1]) {
    return JSON.parse(fencedMatch[1])
  }

  const objectMatch = direct.match(/\{[\s\S]*\}/)
  if (objectMatch?.[0]) {
    return JSON.parse(objectMatch[0])
  }

  throw new Error('No JSON object found in model response')
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) {
    return null
  }

  const asSeconds = Number(headerValue)
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.round(asSeconds * 1000)
  }

  const asDate = Date.parse(headerValue)
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now())
  }

  return null
}

function normalizeActionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function buildActionQueue(nextAdvice: CoachingAdvice, previousAdvice?: CoachingAdvice): string[] {
  const queue: string[] = []
  const seen = new Set<string>()
  const fallback = createDefaultAdvice().whatToDo

  function add(value: string | undefined | null) {
    if (!value) return

    const normalized = normalizeActionText(value)
    if (!normalized) return

    const key = normalized.toLowerCase()
    if (seen.has(key)) return

    seen.add(key)
    queue.push(normalized)
  }

  add(nextAdvice.whatToDo)

  if (previousAdvice) {
    add(previousAdvice.whatToDo)
    for (const step of previousAdvice.nextSteps) {
      add(step)
    }
  }

  for (const step of nextAdvice.nextSteps) {
    add(step)
  }

  if (queue.length === 0) {
    queue.push(fallback)
  }

  return queue.slice(0, 3)
}

function smoothRiskScore(params: {
  nextScore: number
  confidence: number
  previousAdvice?: CoachingAdvice
}): number {
  const targetScore = clamp(Math.round(params.nextScore), 0, 100)
  const previous = params.previousAdvice

  if (!previous) {
    return targetScore
  }

  const previousScore = clamp(Math.round(previous.riskScore), 0, 100)
  const delta = targetScore - previousScore

  if (delta === 0) {
    return previousScore
  }

  const confidence = clamp(params.confidence, 0, 1)
  const baseMaxStep = confidence >= 0.75 ? 18 : confidence >= 0.55 ? 14 : 10
  const crossingHighRisk = previousScore < 70 && targetScore >= 70
  const maxStep = crossingHighRisk ? Math.max(baseMaxStep, 22) : baseMaxStep

  if (Math.abs(delta) <= maxStep) {
    return targetScore
  }

  return clamp(previousScore + Math.sign(delta) * maxStep, 0, 100)
}

function buildHeuristicAdvice(transcript: TranscriptChunk[], previousAdvice?: CoachingAdvice): CoachingAdvice {
  const base = previousAdvice ?? createDefaultAdvice()
  const combined = transcript
    .slice(-10)
    .map((entry) => entry.text.toLowerCase())
    .join(' ')

  let score = 20

  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(combined)) score += 15
  }

  for (const pattern of MEDIUM_RISK_PATTERNS) {
    if (pattern.test(combined)) score += 8
  }

  score = clamp(score, 5, 95)
  const riskLevel = getRiskLevel(score)

  if (riskLevel === 'high') {
    return {
      riskScore: score,
      riskLevel,
      feedback: 'High scam pressure detected. Pause and verify through official channels only.',
      whatToSay: 'I am ending this call and contacting the organization using the number on its official website.',
      whatToDo: 'Do not send money or share codes. End the call now.',
      nextSteps: [
        'Hang up and call the official number yourself.',
        'Change sensitive passwords if anything was shared.',
        'Tell a trusted contact what happened.',
      ],
      confidence: 0.55,
      updatedAt: Date.now(),
    }
  }

  if (riskLevel === 'medium') {
    return {
      riskScore: score,
      riskLevel,
      feedback: 'Some warning signs detected. Keep control of the call and verify identity.',
      whatToSay: 'Please give me your full name, case number, and a public callback number.',
      whatToDo: 'Do not confirm personal data until you verify independently.',
      nextSteps: [
        'Write down their claim and callback number.',
        'Hang up and verify using a known official contact.',
      ],
      confidence: 0.5,
      updatedAt: Date.now(),
    }
  }

  return {
    riskScore: score,
    riskLevel,
    feedback: base.feedback,
    whatToSay: base.whatToSay,
    whatToDo: base.whatToDo,
    nextSteps: base.nextSteps,
    confidence: 0.45,
    updatedAt: Date.now(),
  }
}

function sanitizeAdvice(parsed: z.infer<typeof parsedAdviceSchema>): CoachingAdvice {
  const riskScore = clamp(Math.round(parsed.riskScore), 0, 100)

  return {
    riskScore,
    riskLevel: parsed.riskLevel ?? getRiskLevel(riskScore),
    feedback: parsed.feedback,
    whatToSay: parsed.whatToSay,
    whatToDo: parsed.whatToDo,
    nextSteps: parsed.nextSteps,
    confidence: clamp(parsed.confidence ?? 0.5, 0, 1),
    updatedAt: Date.now(),
  }
}

export function stabilizeAdvice(params: {
  nextAdvice: CoachingAdvice
  previousAdvice?: CoachingAdvice
}): CoachingAdvice {
  const { nextAdvice, previousAdvice } = params
  const confidence = clamp(nextAdvice.confidence, 0, 1)
  const stabilizedRiskScore = smoothRiskScore({
    nextScore: nextAdvice.riskScore,
    confidence,
    previousAdvice,
  })
  const actionQueue = buildActionQueue(nextAdvice, previousAdvice)

  return {
    ...nextAdvice,
    riskScore: stabilizedRiskScore,
    riskLevel: getRiskLevel(stabilizedRiskScore),
    whatToDo: actionQueue[0],
    nextSteps: actionQueue.slice(1, 3),
    confidence,
    updatedAt: Date.now(),
  }
}

export function generateHeuristicAdvice(params: {
  transcript: TranscriptChunk[]
  previousAdvice?: CoachingAdvice
}): CoachingAdvice {
  const { transcript, previousAdvice } = params
  const recentTranscript = getRecentTranscript(transcript)

  if (recentTranscript.length === 0) {
    return previousAdvice ?? createDefaultAdvice()
  }

  return buildHeuristicAdvice(recentTranscript, previousAdvice)
}

export async function generateModelAdvice(params: {
  transcript: TranscriptChunk[]
  previousAdvice?: CoachingAdvice
}): Promise<CoachingAdvice | null> {
  const { transcript, previousAdvice } = params
  const recentTranscript = getRecentTranscript(transcript)

  if (recentTranscript.length === 0) {
    return null
  }

  const groqApiKey = process.env.GROQ_API_KEY
  const model = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct'

  if (!groqApiKey) {
    return null
  }

  const transcriptBlock = formatTranscriptForModel(recentTranscript)
  const previousAdviceBlock = previousAdvice
    ? JSON.stringify({
        riskScore: previousAdvice.riskScore,
        riskLevel: previousAdvice.riskLevel,
        whatToDo: previousAdvice.whatToDo,
        nextSteps: previousAdvice.nextSteps,
        confidence: previousAdvice.confidence,
      })
    : 'none'

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        model,
        temperature: 0.15,
        max_tokens: 240,
        messages: [
          {
            role: 'system',
            content: RISK_SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: [
              'Previous advice snapshot (for continuity):',
              previousAdviceBlock,
              '',
              'Conversation transcript (latest chunk at bottom):',
              transcriptBlock,
              '',
              'Return updated JSON advice now.',
            ].join('\n'),
          },
        ],
      }),
    })

    if (!response.ok) {
      throw new ModelAdviceError(`Groq request failed with status ${response.status}`, {
        statusCode: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
      })
    }

    const payload = await response.json()
    const content = payload?.choices?.[0]?.message?.content

    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Groq response did not include message content')
    }

    const rawJson = parseJsonObject(content)
    const parsed = parsedAdviceSchema.parse(rawJson)

    return sanitizeAdvice(parsed)
  } catch (error) {
    if (error instanceof Error && error.message) {
      throw error
    }

    throw new Error('Groq advice generation failed')
  }
}

export async function generateLiveAdvice(params: {
  transcript: TranscriptChunk[]
  previousAdvice?: CoachingAdvice
}): Promise<CoachingAdvice> {
  const heuristic = stabilizeAdvice({
    nextAdvice: generateHeuristicAdvice(params),
    previousAdvice: params.previousAdvice,
  })

  try {
    const modelAdvice = await generateModelAdvice({
      transcript: params.transcript,
      previousAdvice: params.previousAdvice,
    })

    if (!modelAdvice) {
      return heuristic
    }

    return stabilizeAdvice({
      nextAdvice: modelAdvice,
      previousAdvice: heuristic,
    })
  } catch {
    return heuristic
  }
}
