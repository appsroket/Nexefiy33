-- Knowledge pipeline: file storage, the processing queue, business context
-- indexing, and hybrid (keyword + vector) retrieval.
--
-- Processing state lives in knowledge_sources (CLAUDE.md rule 5): a source is
-- claimed with a lease (`processing_started_at`), retried with backoff
-- (`next_attempt_at`), and a lease that expires is claimed again, so a worker
-- that dies mid-way never leaves a document stuck. Only the server (service
-- role) claims and completes sources; members can ask for reprocessing.

-- ---------------------------------------------------------------------------
-- Storage: one private bucket; every object lives under <organization_id>/.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'knowledge',
  'knowledge',
  false,
  20971520,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html'
  ]
);

create policy "knowledge files: members read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'knowledge'
    and (storage.foldername(name))[1] in (select m::text from private.member_org_ids() as m)
  );

create policy "knowledge files: operators upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'knowledge'
    and (storage.foldername(name))[1] in (select m::text from private.org_ids_with_min_role('operator') as m)
  );

create policy "knowledge files: operators delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'knowledge'
    and (storage.foldername(name))[1] in (select m::text from private.org_ids_with_min_role('operator') as m)
  );

-- ---------------------------------------------------------------------------
-- knowledge_sources: business context sources and processing state
-- ---------------------------------------------------------------------------

alter table public.knowledge_sources
  drop constraint knowledge_sources_source_type_check,
  add constraint knowledge_sources_source_type_check
    check (source_type in ('file', 'url', 'text', 'integration', 'business_context')),
  add column context_item_id uuid,
  add column processing_attempts integer not null default 0 check (processing_attempts between 0 and 100),
  add column processing_started_at timestamptz,
  add column next_attempt_at timestamptz,
  add constraint knowledge_sources_context_item_fk foreign key (context_item_id, organization_id)
    references public.business_context_items (id, organization_id) on delete cascade,
  -- Also the covering index for the composite foreign key above.
  add constraint knowledge_sources_context_item_key unique (context_item_id, organization_id),
  add constraint knowledge_sources_context_item_check
    check ((source_type = 'business_context') = (context_item_id is not null)),
  add constraint knowledge_sources_processing_check
    check (status <> 'processing' or processing_started_at is not null),
  -- No "." or ".." path segments, so a path can never leave its organization's folder.
  add constraint knowledge_sources_storage_path_segments_check
    check (storage_path is null or storage_path !~ '(^|/)\.{1,2}(/|$)');

create index knowledge_sources_queue_idx on public.knowledge_sources (status, next_attempt_at)
  where status in ('pending', 'processing');

create trigger audit_row_change after insert or update or delete on public.knowledge_sources
  for each row execute function private.audit_row_change();

-- Clients create file, URL and text sources, and only files in the knowledge
-- bucket. Business context sources are kept in sync by the trigger below and
-- cannot be created, renamed or deleted directly.
drop policy "knowledge_sources: operators create" on public.knowledge_sources;
create policy "knowledge_sources: operators create" on public.knowledge_sources
  for insert to authenticated
  with check (
    organization_id in (select private.org_ids_with_min_role('operator'))
    and status = 'pending'
    and created_by = (select auth.uid())
    and source_type in ('file', 'url', 'text')
    and (source_type <> 'file' or storage_bucket = 'knowledge')
  );

drop policy "knowledge_sources: operators update" on public.knowledge_sources;
create policy "knowledge_sources: operators update" on public.knowledge_sources
  for update to authenticated
  using (
    organization_id in (select private.org_ids_with_min_role('operator'))
    and source_type <> 'business_context'
  )
  with check (
    organization_id in (select private.org_ids_with_min_role('operator'))
    and source_type <> 'business_context'
  );

drop policy "knowledge_sources: operators delete" on public.knowledge_sources;
create policy "knowledge_sources: operators delete" on public.knowledge_sources
  for delete to authenticated
  using (
    organization_id in (select private.org_ids_with_min_role('operator'))
    and source_type <> 'business_context'
  );

-- ---------------------------------------------------------------------------
-- Business context items are indexed for retrieval through a knowledge source
-- each. Escalation contacts are not: employees get them as structured data,
-- never through search.
-- ---------------------------------------------------------------------------

create function private.business_context_source_name(p_kind text, p_title text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(
    case p_kind
      when 'product' then 'Product or service'
      when 'customer_segment' then 'Target customer'
      when 'goal' then 'Goal'
      when 'department' then 'Department'
      when 'sop' then 'Procedure'
      when 'template' then 'Template'
      when 'faq' then 'FAQ'
      else 'Business context'
    end || ': ' || btrim(p_title),
    300
  );
$$;

create function private.sync_business_context_source()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'escalation_contact' then
    return null;
  end if;

  if new.status = 'archived' then
    update public.knowledge_sources
    set status = 'archived', next_attempt_at = null, processing_started_at = null
    where context_item_id = new.id and organization_id = new.organization_id;
    return null;
  end if;

  if tg_op = 'UPDATE'
    and new.title is not distinct from old.title
    and new.body is not distinct from old.body
    and new.attributes is not distinct from old.attributes
    and new.status is not distinct from old.status then
    return null;
  end if;

  insert into public.knowledge_sources (organization_id, name, source_type, context_item_id, status, created_by)
  values (new.organization_id, private.business_context_source_name(new.kind, new.title), 'business_context',
    new.id, 'pending', coalesce(new.updated_by, new.created_by))
  on conflict (context_item_id, organization_id) do update
    set name = excluded.name,
        status = 'pending',
        error_message = null,
        processing_attempts = 0,
        processing_started_at = null,
        next_attempt_at = null;
  return null;
end;
$$;

create trigger sync_knowledge_source after insert or update on public.business_context_items
  for each row execute function private.sync_business_context_source();

-- ---------------------------------------------------------------------------
-- Keyword search over chunks (works with or without embeddings)
-- ---------------------------------------------------------------------------

alter table public.knowledge_chunks
  add column search_vector tsvector generated always as (to_tsvector('english'::regconfig, content)) stored;

create index knowledge_chunks_search_idx on public.knowledge_chunks using gin (search_vector);

-- ---------------------------------------------------------------------------
-- Hybrid retrieval. SECURITY INVOKER: RLS limits rows to the caller's
-- organizations, and the explicit organization filter keeps multi-org users
-- (and the service role, which bypasses RLS) inside the organization they are
-- working in. Keyword and vector candidates are merged by reciprocal rank
-- fusion. Query terms are OR-ed so a natural-language question still matches
-- passages that contain only some of its words; ts_rank_cd favours passages
-- that contain more of them.
-- ---------------------------------------------------------------------------

create function public.search_knowledge(
  p_organization_id uuid,
  p_query text,
  p_query_embedding extensions.vector(1024) default null,
  p_match_count integer default 8,
  p_source_ids uuid[] default null
)
returns table (
  chunk_id uuid,
  source_id uuid,
  source_name text,
  source_type text,
  chunk_index integer,
  content text,
  metadata jsonb,
  keyword_rank real,
  similarity double precision,
  score double precision
)
language sql
stable
security invoker
set search_path = ''
set hnsw.iterative_scan = 'relaxed_order'
as $$
  with params as (
    select
      least(greatest(coalesce(p_match_count, 8), 1), 50) as match_count,
      nullif(replace(plainto_tsquery('english'::regconfig, left(coalesce(p_query, ''), 2000))::text, ' & ', ' | '), '')
        ::tsquery as tsq
  ),
  keyword as (
    select c.id, ts_rank_cd(c.search_vector, p.tsq) as rank,
      row_number() over (order by ts_rank_cd(c.search_vector, p.tsq) desc, c.id) as rn
    from public.knowledge_chunks as c
    join public.knowledge_sources as s on s.id = c.source_id and s.organization_id = c.organization_id
    cross join params as p
    where p.tsq is not null
      and c.organization_id = p_organization_id
      and s.status = 'ready'
      and (p_source_ids is null or c.source_id = any (p_source_ids))
      and c.search_vector operator(pg_catalog.@@) p.tsq
    order by rank desc, c.id
    limit 50
  ),
  semantic as (
    select c.id,
      1 - (c.embedding operator(extensions.<=>) p_query_embedding) as similarity,
      row_number() over (order by c.embedding operator(extensions.<=>) p_query_embedding, c.id) as rn
    from public.knowledge_chunks as c
    join public.knowledge_sources as s on s.id = c.source_id and s.organization_id = c.organization_id
    where p_query_embedding is not null
      and c.embedding is not null
      and c.organization_id = p_organization_id
      and s.status = 'ready'
      and (p_source_ids is null or c.source_id = any (p_source_ids))
    order by c.embedding operator(extensions.<=>) p_query_embedding, c.id
    limit 50
  ),
  fused as (
    select coalesce(k.id, v.id) as id, k.rank as keyword_rank, v.similarity,
      coalesce(1.0 / (60 + k.rn), 0) + coalesce(1.0 / (60 + v.rn), 0) as score
    from keyword as k
    full join semantic as v on v.id = k.id
  )
  select c.id, c.source_id, s.name, s.source_type, c.chunk_index, c.content, c.metadata,
    f.keyword_rank, f.similarity, f.score::double precision
  from fused as f
  join public.knowledge_chunks as c on c.id = f.id and c.organization_id = p_organization_id
  join public.knowledge_sources as s on s.id = c.source_id and s.organization_id = c.organization_id
  order by f.score desc, c.id
  limit (select match_count from params);
$$;

revoke all on function public.search_knowledge(uuid, text, extensions.vector, integer, uuid[]) from public, anon;
grant execute on function public.search_knowledge(uuid, text, extensions.vector, integer, uuid[])
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Queue: claim (server only) and reprocess (operators)
-- ---------------------------------------------------------------------------

-- Claims up to p_limit sources that are due: pending ones whose retry time has
-- come, and processing ones whose lease expired (the worker died). A source
-- whose lease expired after p_max_attempts claims is failed instead of being
-- claimed again. FOR UPDATE SKIP LOCKED lets several workers run at once.
create function public.claim_knowledge_sources(
  p_limit integer default 5,
  p_organization_id uuid default null,
  p_lease_seconds integer default 600,
  p_max_attempts integer default 3
)
returns table (source_id uuid, organization_id uuid, attempt integer)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.knowledge_sources as s
  set status = 'failed',
      error_message = 'Processing stopped responding too many times. Try reprocessing it.',
      processing_started_at = null,
      next_attempt_at = null
  where s.status = 'processing'
    and s.processing_started_at < now() - make_interval(secs => p_lease_seconds)
    and s.processing_attempts >= p_max_attempts
    and (p_organization_id is null or s.organization_id = p_organization_id);

  return query
  with due as (
    select k.id
    from public.knowledge_sources as k
    where (p_organization_id is null or k.organization_id = p_organization_id)
      and (
        (k.status = 'pending' and (k.next_attempt_at is null or k.next_attempt_at <= now()))
        or (k.status = 'processing' and k.processing_started_at < now() - make_interval(secs => p_lease_seconds))
      )
    order by coalesce(k.next_attempt_at, k.created_at), k.id
    limit least(greatest(coalesce(p_limit, 5), 1), 50)
    for update skip locked
  )
  update public.knowledge_sources as s
  set status = 'processing',
      processing_started_at = now(),
      processing_attempts = s.processing_attempts + 1,
      next_attempt_at = null,
      error_message = null
  from due
  where s.id = due.id
  returning s.id, s.organization_id, s.processing_attempts;
end;
$$;

revoke all on function public.claim_knowledge_sources(integer, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_knowledge_sources(integer, uuid, integer, integer) to service_role;

-- Queues a ready or failed source for processing again (for example after a
-- fix to the file, or once embeddings are configured). Operators and above.
-- Returns the source's organization so the caller can start processing.
create function public.reprocess_knowledge_source(p_source_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
begin
  update public.knowledge_sources as s
  set status = 'pending',
      error_message = null,
      processing_attempts = 0,
      processing_started_at = null,
      next_attempt_at = null
  where s.id = p_source_id
    and s.status in ('ready', 'failed')
    and s.organization_id in (select private.org_ids_with_min_role('operator'))
  returning s.organization_id into v_organization_id;

  if v_organization_id is null then
    raise exception 'Knowledge source not found or not ready to reprocess' using errcode = 'P0002';
  end if;
  return v_organization_id;
end;
$$;

revoke all on function public.reprocess_knowledge_source(uuid) from public, anon;
grant execute on function public.reprocess_knowledge_source(uuid) to authenticated;
