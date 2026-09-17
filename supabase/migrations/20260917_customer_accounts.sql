-- Customer account foundation for Molt.
-- Applied to the existing MOLT Supabase project on 2026-09-17.
-- Additive only: the legacy migrations/pages/flags tables are intentionally untouched.

create extension if not exists pgcrypto;

create table if not exists public.molt_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.molt_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'My workspace',
  plan text not null default 'beta' check (plan in ('beta','creator','studio','agency')),
  status text not null default 'active' check (status in ('active','past_due','paused','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists molt_workspaces_owner_unique on public.molt_workspaces(owner_user_id);

create table if not exists public.molt_workspace_members (
  workspace_id uuid not null references public.molt_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id,user_id)
);

create table if not exists public.molt_subscriptions (
  workspace_id uuid primary key references public.molt_workspaces(id) on delete cascade,
  provider text not null default 'stripe' check (provider in ('stripe')),
  provider_customer_id text unique,
  provider_subscription_id text unique,
  status text not null default 'inactive' check (status in ('inactive','trialing','active','past_due','cancelled','paused')),
  plan text not null default 'beta' check (plan in ('beta','creator','studio','agency')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.molt_credit_accounts (
  workspace_id uuid primary key references public.molt_workspaces(id) on delete cascade,
  available integer not null default 0 check (available >= 0),
  reserved integer not null default 0 check (reserved >= 0),
  lifetime_granted integer not null default 0 check (lifetime_granted >= 0),
  lifetime_spent integer not null default 0 check (lifetime_spent >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.molt_credit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.molt_workspaces(id) on delete cascade,
  kind text not null check (kind in ('grant','reserve','settle','release','adjustment','expire')),
  amount integer not null check (amount > 0),
  job_id uuid,
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists molt_credit_events_workspace_created on public.molt_credit_events(workspace_id,created_at desc);

create table if not exists public.molt_quotes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.molt_workspaces(id) on delete cascade,
  source_url text not null,
  page_count integer not null check (page_count between 1 and 100),
  complexity jsonb not null default '{}'::jsonb,
  credits integer not null check (credits > 0),
  status text not null default 'draft' check (status in ('draft','approved','expired','consumed','cancelled')),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  approved_at timestamptz
);
create index if not exists molt_quotes_workspace_created on public.molt_quotes(workspace_id,created_at desc);

alter table public.molt_profiles enable row level security;
alter table public.molt_workspaces enable row level security;
alter table public.molt_workspace_members enable row level security;
alter table public.molt_subscriptions enable row level security;
alter table public.molt_credit_accounts enable row level security;
alter table public.molt_credit_events enable row level security;
alter table public.molt_quotes enable row level security;

drop policy if exists "molt profile self read" on public.molt_profiles;
create policy "molt profile self read" on public.molt_profiles for select to authenticated using (id=(select auth.uid()));
drop policy if exists "molt profile self update" on public.molt_profiles;
create policy "molt profile self update" on public.molt_profiles for update to authenticated using (id=(select auth.uid())) with check (id=(select auth.uid()));

drop policy if exists "molt workspace member read" on public.molt_workspaces;
create policy "molt workspace member read" on public.molt_workspaces for select to authenticated using (
  exists (select 1 from public.molt_workspace_members m where m.workspace_id=id and m.user_id=(select auth.uid()))
);
drop policy if exists "molt workspace owner update" on public.molt_workspaces;
create policy "molt workspace owner update" on public.molt_workspaces for update to authenticated using (owner_user_id=(select auth.uid())) with check (owner_user_id=(select auth.uid()));

drop policy if exists "molt member read own workspace" on public.molt_workspace_members;
create policy "molt member read own workspace" on public.molt_workspace_members for select to authenticated using (user_id=(select auth.uid()));

drop policy if exists "molt subscription member read" on public.molt_subscriptions;
create policy "molt subscription member read" on public.molt_subscriptions for select to authenticated using (
  exists (select 1 from public.molt_workspace_members m where m.workspace_id=molt_subscriptions.workspace_id and m.user_id=(select auth.uid()))
);
drop policy if exists "molt credit account member read" on public.molt_credit_accounts;
create policy "molt credit account member read" on public.molt_credit_accounts for select to authenticated using (
  exists (select 1 from public.molt_workspace_members m where m.workspace_id=molt_credit_accounts.workspace_id and m.user_id=(select auth.uid()))
);
drop policy if exists "molt credit events member read" on public.molt_credit_events;
create policy "molt credit events member read" on public.molt_credit_events for select to authenticated using (
  exists (select 1 from public.molt_workspace_members m where m.workspace_id=molt_credit_events.workspace_id and m.user_id=(select auth.uid()))
);
drop policy if exists "molt quotes member read" on public.molt_quotes;
create policy "molt quotes member read" on public.molt_quotes for select to authenticated using (
  exists (select 1 from public.molt_workspace_members m where m.workspace_id=molt_quotes.workspace_id and m.user_id=(select auth.uid()))
);

grant select,update on public.molt_profiles to authenticated;
grant select,update on public.molt_workspaces to authenticated;
grant select on public.molt_workspace_members,public.molt_subscriptions,public.molt_credit_accounts,public.molt_credit_events,public.molt_quotes to authenticated;

create or replace function public.molt_ensure_account()
returns uuid language plpgsql security definer set search_path=''
as $$
declare uid uuid:=auth.uid(); wid uuid;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  insert into public.molt_profiles(id) values(uid) on conflict(id) do nothing;
  select id into wid from public.molt_workspaces where owner_user_id=uid limit 1;
  if wid is null then insert into public.molt_workspaces(owner_user_id,name) values(uid,'My workspace') returning id into wid; end if;
  insert into public.molt_workspace_members(workspace_id,user_id,role) values(wid,uid,'owner') on conflict(workspace_id,user_id) do nothing;
  insert into public.molt_credit_accounts(workspace_id) values(wid) on conflict(workspace_id) do nothing;
  insert into public.molt_subscriptions(workspace_id) values(wid) on conflict(workspace_id) do nothing;
  return wid;
end;
$$;
revoke all on function public.molt_ensure_account() from public;
grant execute on function public.molt_ensure_account() to authenticated;
