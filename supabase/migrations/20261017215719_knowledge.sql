-- Business knowledge: sources (documents, URLs, text, integration content)
-- and their chunks with embeddings.
--
-- Embeddings: Voyage AI `voyage-4`, 1024 dimensions, cosine distance
-- (ADR-008). Every chunk records the model that produced its vector; switching
-- models means re-embedding, because vectors from different models are not
-- comparable.

create table public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 300),
  source_type text not null check (source_type in ('file', 'url', 'text', 'integration')),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed', 'archived')),
  storage_bucket text check (char_length(storage_bucket) between 1 and 63),
  storage_path text check (char_length(storage_path) between 1 and 1024),
  source_url text check (source_url ~ '^https?://' and char_length(source_url) <= 2048),
  -- Set when source_type = 'integration'; FK added with the integrations table.
  integration_id uuid,
  mime_type text check (char_length(mime_type) <= 255),
  byte_size bigint check (byte_size >= 0),
  content_sha256 text check (content_sha256 ~ '^[0-9a-f]{64}$'),
  embedding_model text check (char_length(embedding_model) <= 100),
  chunk_count integer not null default 0 check (chunk_count >= 0),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and not private.jsonb_contains_secret(metadata)),
  error_message text check (char_length(error_message) <= 2000),
  last_indexed_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  check ((source_type = 'file') = (storage_path is not null and storage_bucket is not null)),
  check (source_type <> 'url' or source_url is not null),
  check ((source_type = 'integration') = (integration_id is not null)),
  -- Uploaded files live under the organization's own storage folder.
  check (storage_path is null or storage_path like organization_id::text || '/%'),
  check (status <> 'failed' or error_message is not null)
);

create index knowledge_sources_org_status_idx on public.knowledge_sources (organization_id, status, created_at desc);

create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  source_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (char_length(content) between 1 and 20000),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  token_count integer check (token_count > 0),
  embedding extensions.vector(1024),
  embedding_model text check (char_length(embedding_model) <= 100),
  -- Retrieval metadata: page, heading path, character offsets, URL anchor.
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and not private.jsonb_contains_secret(metadata)),
  created_at timestamptz not null default now(),
  foreign key (source_id, organization_id)
    references public.knowledge_sources (id, organization_id) on delete cascade,
  unique (source_id, chunk_index),
  check ((embedding is null) = (embedding_model is null))
);

create index knowledge_chunks_org_source_idx on public.knowledge_chunks (organization_id, source_id);
create index knowledge_chunks_embedding_idx on public.knowledge_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

create trigger set_updated_at before update on public.knowledge_sources
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Retrieval. SECURITY INVOKER: RLS limits results to the caller's
-- organizations, and the explicit organization filter keeps multi-org users'
-- results to the organization they are working in.
-- ---------------------------------------------------------------------------

create function public.match_knowledge_chunks(
  p_organization_id uuid,
  p_query_embedding extensions.vector(1024),
  p_match_count integer default 8,
  p_source_ids uuid[] default null,
  p_min_similarity double precision default 0
)
returns table (
  chunk_id uuid,
  source_id uuid,
  source_name text,
  chunk_index integer,
  content text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id,
    c.source_id,
    s.name,
    c.chunk_index,
    c.content,
    c.metadata,
    1 - (c.embedding operator(extensions.<=>) p_query_embedding) as similarity
  from public.knowledge_chunks as c
  join public.knowledge_sources as s
    on s.id = c.source_id and s.organization_id = c.organization_id
  where c.organization_id = p_organization_id
    and s.status = 'ready'
    and c.embedding is not null
    and (p_source_ids is null or c.source_id = any (p_source_ids))
    and 1 - (c.embedding operator(extensions.<=>) p_query_embedding) >= p_min_similarity
  order by c.embedding operator(extensions.<=>) p_query_embedding
  limit least(greatest(coalesce(p_match_count, 8), 1), 50);
$$;

revoke all on function public.match_knowledge_chunks(uuid, extensions.vector, integer, uuid[], double precision)
  from public, anon;
grant execute on function public.match_knowledge_chunks(uuid, extensions.vector, integer, uuid[], double precision)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security and privileges
-- Members read; operators and above manage sources. Chunks are written only by
-- the server-side ingestion pipeline.
-- ---------------------------------------------------------------------------

alter table public.knowledge_sources enable row level security;
alter table public.knowledge_chunks enable row level security;

revoke all on public.knowledge_sources, public.knowledge_chunks from anon, authenticated;

grant select, delete on public.knowledge_sources to authenticated;
grant insert (organization_id, name, source_type, storage_bucket, storage_path, source_url,
  integration_id, mime_type, byte_size, content_sha256, metadata)
  on public.knowledge_sources to authenticated;
grant update (name, metadata) on public.knowledge_sources to authenticated;

create policy "knowledge_sources: members read" on public.knowledge_sources
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "knowledge_sources: operators create" on public.knowledge_sources
  for insert to authenticated
  with check (
    organization_id in (select private.org_ids_with_min_role('operator'))
    and status = 'pending'
    and created_by = (select auth.uid())
  );

create policy "knowledge_sources: operators update" on public.knowledge_sources
  for update to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')))
  with check (organization_id in (select private.org_ids_with_min_role('operator')));

create policy "knowledge_sources: operators delete" on public.knowledge_sources
  for delete to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')));

grant select on public.knowledge_chunks to authenticated;

create policy "knowledge_chunks: members read" on public.knowledge_chunks
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));
