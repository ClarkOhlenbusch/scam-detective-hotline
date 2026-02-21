-- Tenants table: each tenant is identified by a unique URL slug
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  phone_number text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- Index for fast slug lookups
create index if not exists idx_tenants_slug on public.tenants (slug);

-- Enable RLS (policies allow public read by slug, write via service role)
alter table public.tenants enable row level security;

-- Anyone can read tenants (needed for the public URL-slug-based access)
create policy "tenants_select_public" on public.tenants
  for select using (true);

-- Only service role (server-side) can insert/update/delete
-- No insert/update/delete policies means anon key cannot mutate data.
-- Server actions use the service_role key to bypass RLS.
