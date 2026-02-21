import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { DetectiveBadge } from '@/components/detective-badge'
import { SetupForm } from '@/components/setup-form'
import { NoirFrame } from '@/components/noir-frame'

export default async function TenantSetupPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const supabase = await createClient()

  console.log('[v0] Setup page loading for slug:', slug)

  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, slug, name')
    .eq('slug', slug)
    .single()

  console.log('[v0] Setup tenant query result:', { tenant, error: tenantError })

  if (!tenant) {
    notFound()
  }

  return (
    <NoirFrame>
      <DetectiveBadge />
      {tenant.name && (
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          {tenant.name}
        </p>
      )}
      <p className="max-w-xs text-center font-mono text-sm leading-relaxed text-muted-foreground">
        Save your number once. When a suspicious call starts, tap to launch silent live coaching.
      </p>
      <div className="h-px w-16 bg-border" role="separator" />
      <SetupForm slug={slug} />
    </NoirFrame>
  )
}
