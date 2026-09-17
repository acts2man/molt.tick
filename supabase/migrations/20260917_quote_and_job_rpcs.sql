-- Customer quote and job creation RPCs. Quotes are calculated server-side.
create or replace function public.molt_create_quote(p_source_url text,p_page_count integer,p_complexity text,p_repairs integer default 2)
returns table(id uuid,credits integer,expires_at timestamptz)
language plpgsql security definer set search_path=''
as $$
declare wid uuid; per_page integer; page_credits integer; refinement integer; qid uuid; total integer; exp timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_page_count < 1 or p_page_count > 100 then raise exception 'Page count must be between 1 and 100'; end if;
  if p_repairs < 0 or p_repairs > 6 then raise exception 'Correction rounds must be between 0 and 6'; end if;
  if p_complexity not in ('simple','standard','complex') then raise exception 'Unknown complexity'; end if;
  if p_source_url !~ '^https?://[^[:space:]]+\.[^[:space:]]+' then raise exception 'Enter a public http(s) website'; end if;
  select workspace_id into wid from public.molt_workspace_members where user_id=auth.uid() order by created_at limit 1;
  if wid is null then wid:=public.molt_ensure_account(); end if;
  per_page:=case p_complexity when 'simple' then 10 when 'standard' then 20 else 40 end;
  page_credits:=p_page_count*per_page;
  refinement:=ceil(page_credits*greatest(0,p_repairs-2)*0.15)::integer;
  total:=10+page_credits+refinement;
  exp:=now()+interval '24 hours';
  insert into public.molt_quotes(workspace_id,source_url,page_count,complexity,credits,expires_at)
  values(wid,p_source_url,p_page_count,jsonb_build_object('version','planning-2026-09-17','class',p_complexity,'repairs',p_repairs,'page_credits',page_credits,'refinement',refinement),total,exp)
  returning public.molt_quotes.id into qid;
  return query select qid,total,exp;
end $$;

create or replace function public.molt_approve_quote(p_quote uuid)
returns public.molt_quotes language plpgsql security definer set search_path=''
as $$
declare q public.molt_quotes%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into q from public.molt_quotes where id=p_quote for update;
  if not found then raise exception 'Quote not found'; end if;
  if not exists(select 1 from public.molt_workspace_members where workspace_id=q.workspace_id and user_id=auth.uid()) then raise exception 'Workspace access denied'; end if;
  if q.expires_at<=now() then update public.molt_quotes set status='expired' where id=q.id; raise exception 'This quote has expired'; end if;
  if q.status='draft' then update public.molt_quotes set status='approved',approved_at=now() where id=q.id returning * into q; end if;
  if q.status<>'approved' then raise exception 'Quote cannot be approved from its current state'; end if;
  return q;
end $$;

create or replace function public.molt_create_job_from_quote(p_quote uuid,p_idempotency_key text)
returns public.molt_jobs language plpgsql security definer set search_path=''
as $$
declare q public.molt_quotes%rowtype; acct public.molt_credit_accounts%rowtype; j public.molt_jobs%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(p_idempotency_key)<8 then raise exception 'Invalid idempotency key'; end if;
  select * into q from public.molt_quotes where id=p_quote for update;
  if not found then raise exception 'Quote not found'; end if;
  if not exists(select 1 from public.molt_workspace_members where workspace_id=q.workspace_id and user_id=auth.uid()) then raise exception 'Workspace access denied'; end if;
  if q.status='consumed' then
    select * into j from public.molt_jobs where quote_id=q.id order by created_at limit 1;
    if found then return j; end if;
    raise exception 'Quote was already consumed';
  end if;
  if q.status<>'approved' or q.expires_at<=now() then raise exception 'Approve a current quote before starting'; end if;
  if exists(select 1 from public.molt_credit_events where idempotency_key=p_idempotency_key) then
    select * into j from public.molt_jobs where quote_id=q.id order by created_at limit 1;
    if found then return j; end if;
    raise exception 'Idempotency key already used';
  end if;
  select * into acct from public.molt_credit_accounts where workspace_id=q.workspace_id for update;
  if not found or acct.available<q.credits then raise exception 'Not enough Molt credits for this reconstruction'; end if;
  insert into public.molt_jobs(workspace_id,quote_id,source_url,status,credits_reserved)
  values(q.workspace_id,q.id,q.source_url,'queued',q.credits) returning * into j;
  update public.molt_credit_accounts set available=available-q.credits,reserved=reserved+q.credits,updated_at=now() where workspace_id=q.workspace_id;
  insert into public.molt_credit_events(workspace_id,kind,amount,job_id,idempotency_key,metadata)
  values(q.workspace_id,'reserve',q.credits,j.id,p_idempotency_key,jsonb_build_object('quote_id',q.id));
  update public.molt_quotes set status='consumed' where id=q.id;
  return j;
end $$;

revoke all on function public.molt_create_quote(text,integer,text,integer) from public;
revoke all on function public.molt_approve_quote(uuid) from public;
revoke all on function public.molt_create_job_from_quote(uuid,text) from public;
grant execute on function public.molt_create_quote(text,integer,text,integer) to authenticated;
grant execute on function public.molt_approve_quote(uuid) to authenticated;
grant execute on function public.molt_create_job_from_quote(uuid,text) to authenticated;
