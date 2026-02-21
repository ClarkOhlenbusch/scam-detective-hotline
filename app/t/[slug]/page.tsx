import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { CasePanel } from '@/components/case-panel'

export default async function TenantHomePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const supabase = await createClient()

  console.log('[v0] Tenant page loading for slug:', slug)

  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, slug, name, phone_number')
    .eq('slug', slug)
    .single()

  console.log('[v0] Tenant query result:', { tenant, error: tenantError })

  if (!tenant) {
    notFound()
  }

  // If no phone number saved yet, redirect to setup
  if (!tenant.phone_number) {
    const { redirect } = await import('next/navigation')
    redirect(`/t/${slug}/setup`)
  }

  return (
    <main className="flex min-h-dvh justify-center bg-background px-4 py-5 sm:px-6 sm:py-8">
      <div className="flex w-full max-w-md flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground/80">
            Scam Detective Hotline
          </p>
          {tenant.name && (
            <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
              {tenant.name}
            </p>
          )}
        </div>
        <CasePanel slug={slug} maskedPhone={maskForDisplay(tenant.phone_number)} />
      </div>
    </main>
  )
}

function maskForDisplay(phone: string): string {
  if (phone.length <= 4) return phone
  return phone.slice(0, -4).replace(/./g, '*') + phone.slice(-4)
}
