export async function muteAssistantByControlUrl(
  controlUrl: string,
  vapiPrivateKey?: string,
): Promise<boolean> {
  const payload = JSON.stringify({ control: 'mute-assistant' })

  const firstAttempt = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: payload,
    signal: AbortSignal.timeout(5_000),
  })

  if (firstAttempt.ok) {
    return true
  }

  if (!vapiPrivateKey) {
    return false
  }

  const retry = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${vapiPrivateKey}`,
      'Content-Type': 'application/json',
    },
    body: payload,
    signal: AbortSignal.timeout(5_000),
  })

  return retry.ok
}
