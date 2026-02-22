export const BRAND_NAME = 'Marlowe'
export const BRAND_TITLE = 'Marlowe'
export const BRAND_DESCRIPTION = 'Open a case file. Get a second opinion before you act.'
export const BRAND_CASE_NAME = 'Marlowe Case File'

const LEGACY_DEFAULT_CASE_NAME = 'scam detective case'

export function resolveTenantDisplayName(name: string | null | undefined): string | null {
  if (!name) return null

  const trimmed = name.trim()
  if (!trimmed) return null

  if (trimmed.toLowerCase() === LEGACY_DEFAULT_CASE_NAME) {
    return BRAND_CASE_NAME
  }

  return trimmed
}
