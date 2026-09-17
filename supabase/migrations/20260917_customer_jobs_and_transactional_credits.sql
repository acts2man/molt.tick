-- Transactional job and credit accounting foundation for customer workspaces.
create table if not exists public.molt_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.molt_workspaces(id) on delete cascade,
  quote_id uuid references public.molt_quotes(id) on delete set null,
  source_url text not null,
  status text not null default 'draft' check (status in ('draft','quoted','queued','running','review','needs_work','failed','cancelled','complete')),
  runner text,
  credits_reserved integer not null default 0 check (credits_reserved >= 0),
  credits_spent integer not null default 0 check (credits_spent >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists molt_jobs_workspace_created on public.molt_jobs(workspace_id,created_at desc);
alter table public.molt_jobs enable row level security;
drop policy if exists "molt jobs member read" on public.molt_jobs;
create policy "molt jobs member read" on public.molt_jobs for select to authenticated using (
  exists (select 1 from public.molt_workspace_members m where m.workspace_id=molt_jobs.workspace_id and m.user_id=(select auth.uid()))
);
grant select on public.molt_jobs to authenticated;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='molt_credit_events_job_id_fkey') then
    alter table public.molt_credit_events add constraint molt_credit_events_job_id_fkey foreign key(job_id) references public.molt_jobs(id) on delete set null;
  end if;
end $$;

create or replace function public.molt_reserve_credits(p_workspace uuid,p_job uuid,p_amount integer,p_key text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare acct public.molt_credit_accounts%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_amount <= 0 or length(p_key) < 8 then raise exception 'Invalid reservation'; end if;
  if not exists(select 1 from public.molt_workspace_members where workspace_id=p_workspace and user_id=auth.uid()) then raise exception 'Workspace access denied'; end if;
  if exists(select 1 from public.molt_credit_events where idempotency_key=p_key) then
    select * into acct from public.molt_credit_accounts where workspace_id=p_workspace;
    return jsonb_build_object('available',acct.available,'reserved',acct.reserved,'idempotent',true);
  end if;
  select * into acct from public.molt_credit_accounts where workspace_id=p_workspace for update;
  if not found then raise exception 'Credit account not found'; end if;
  if acct.available < p_amount then raise exception 'Insufficient credits'; end if;
  update public.molt_credit_accounts set available=available-p_amount,reserved=reserved+p_amount,updated_at=now() where workspace_id=p_workspace;
  insert into public.molt_credit_events(workspace_id,kind,amount,job_id,idempotency_key) values(p_workspace,'reserve',p_amount,p_job,p_key);
  update public.molt_jobs set credits_reserved=credits_reserved+p_amount,updated_at=now() where id=p_job and workspace_id=p_workspace;
  return jsonb_build_object('available',acct.available-p_amount,'reserved',acct.reserved+p_amount,'idempotent',false);
end $$;

create or replace function public.molt_release_credits(p_workspace uuid,p_job uuid,p_amount integer,p_key text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare acct public.molt_credit_accounts%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_amount <= 0 or length(p_key) < 8 then raise exception 'Invalid release'; end if;
  if not exists(select 1 from public.molt_workspace_members where workspace_id=p_workspace and user_id=auth.uid()) then raise exception 'Workspace access denied'; end if;
  if exists(select 1 from public.molt_credit_events where idempotency_key=p_key) then
    select * into acct from public.molt_credit_accounts where workspace_id=p_workspace;
    return jsonb_build_object('available',acct.available,'reserved',acct.reserved,'idempotent',true);
  end if;
  select * into acct from public.molt_credit_accounts where workspace_id=p_workspace for update;
  if not found or acct.reserved < p_amount then raise exception 'Reserved balance is too small'; end if;
  update public.molt_credit_accounts set available=available+p_amount,reserved=reserved-p_amount,updated_at=now() where workspace_id=p_workspace;
  insert into public.molt_credit_events(workspace_id,kind,amount,job_id,idempotency_key) values(p_workspace,'release',p_amount,p_job,p_key);
  update public.molt_jobs set credits_reserved=greatest(0,credits_reserved-p_amount),updated_at=now() where id=p_job and workspace_id=p_workspace;
  return jsonb_build_object('available',acct.available+p_amount,'reserved',acct.reserved-p_amount,'idempotent',false);
end $$;

create or replace function public.molt_settle_credits(p_workspace uuid,p_job uuid,p_amount integer,p_key text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare acct public.molt_credit_accounts%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_amount <= 0 or length(p_key) < 8 then raise exception 'Invalid settlement'; end if;
  if not exists(select 1 from public.molt_workspace_members where workspace_id=p_workspace and user_id=auth.uid()) then raise exception 'Workspace access denied'; end if;
  if exists(select 1 from public.molt_credit_events where idempotency_key=p_key) then
    select * into acct from public.molt_credit_accounts where workspace_id=p_workspace;
    return jsonb_build_object('available',acct.available,'reserved',acct.reserved,'lifetime_spent',acct.lifetime_spent,'idempotent',true);
  end if;
  select * into acct from public.molt_credit_accounts where workspace_id=p_workspace for update;
  if not found or acct.reserved < p_amount then raise exception 'Reserved balance is too small'; end if;
  update public.molt_credit_accounts set reserved=reserved-p_amount,lifetime_spent=lifetime_spent+p_amount,updated_at=now() where workspace_id=p_workspace;
  insert into public.molt_credit_events(workspace_id,kind,amount,job_id,idempotency_key) values(p_workspace,'settle',p_amount,p_job,p_key);
  update public.molt_jobs set credits_reserved=greatest(0,credits_reserved-p_amount),credits_spent=credits_spent+p_amount,updated_at=now() where id=p_job and workspace_id=p_workspace;
  return jsonb_build_object('available',acct.available,'reserved',acct.reserved-p_amount,'lifetime_spent',acct.lifetime_spent+p_amount,'idempotent',false);
end $$;

revoke all on function public.molt_reserve_credits(uuid,uuid,integer,text) from public;
revoke all on function public.molt_release_credits(uuid,uuid,integer,text) from public;
revoke all on function public.molt_settle_credits(uuid,uuid,integer,text) from public;
grant execute on function public.molt_reserve_credits(uuid,uuid,integer,text) to authenticated;
grant execute on function public.molt_release_credits(uuid,uuid,integer,text) to authenticated;
grant execute on function public.molt_settle_credits(uuid,uuid,integer,text) to authenticated;
