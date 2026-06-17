-- ============================================================
--  Orbital — Supabase schema
--  Run this once in your Supabase project:
--  Dashboard → SQL Editor → New query → paste → Run.
--  Safe to re-run (idempotent).
-- ============================================================

-- ---- Tables -------------------------------------------------
-- Saved chat conversations and their messages (persistent chat history).
create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  model_id    uuid,
  title       text not null default 'New chat',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role            text not null,              -- 'user' | 'assistant'
  content         text not null default '',
  created_at      timestamptz not null default now()
);

create table if not exists public.models (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  label       text not null default 'New model',
  provider    text not null default 'openrouter',
  model       text not null default '',
  enabled     boolean not null default true,
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists public.agents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null default 'New agent',
  kind         text not null default 'hermes',
  model_id     uuid,
  instructions text not null default '',
  tools        jsonb not null default '[]'::jsonb,
  enabled      boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists public.memory (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  scope       text not null default 'shared',   -- 'shared' or a model id
  author      text not null default 'user',
  text        text not null,
  tags        jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists public.files (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  scope        text not null default 'combined', -- 'combined' or a model id
  path         text not null,
  content      text not null default '',
  storage_path text,                              -- set when backed by Storage upload
  size_bytes   bigint,
  updated_at   timestamptz not null default now()
);

create table if not exists public.harnesses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  key         text not null,                     -- stable slug, e.g. 'notebooklm'
  name        text not null,
  category    text not null default 'tool',
  description text not null default '',
  docs_url    text not null default '',
  status      text not null default 'available', -- 'available' | 'installed'
  updated_at  timestamptz not null default now()
);

-- User-authored skills. A skill is a named, reusable instruction an agent can
-- invoke as a tool (skill.run). Running a skill executes its instructions as a
-- focused LLM task against the agent's model.
create table if not exists public.skills (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,                     -- slug-ish, e.g. 'summarize'
  description  text not null default '',
  instructions text not null default '',
  created_at   timestamptz not null default now()
);

-- Tools a user has chosen to auto-approve ("approve every time"). If a tool is
-- listed here, the agent runs it without pausing to ask.
create table if not exists public.auto_approvals (
  user_id    uuid not null references auth.users(id) on delete cascade,
  tool       text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, tool)
);

-- Per-user provider API keys. The value is AES-256-GCM encrypted by the app
-- before it ever reaches this table, and is NEVER sent back to the browser.
create table if not exists public.provider_keys (
  user_id     uuid not null references auth.users(id) on delete cascade,
  provider    text not null,                     -- 'openrouter','openai','claude',...
  enc_key     text not null,                     -- encrypted blob (base64)
  updated_at  timestamptz not null default now(),
  primary key (user_id, provider)
);

-- ---- Indexes ------------------------------------------------
create index if not exists models_user_idx    on public.models(user_id);
create index if not exists agents_user_idx     on public.agents(user_id);
create index if not exists memory_user_idx     on public.memory(user_id);
create index if not exists files_user_idx      on public.files(user_id);
create index if not exists harnesses_user_idx  on public.harnesses(user_id);
create index if not exists conversations_user_idx on public.conversations(user_id, updated_at desc);
create index if not exists messages_conv_idx      on public.messages(conversation_id, created_at);
create index if not exists messages_user_idx      on public.messages(user_id);

-- ---- Row Level Security ------------------------------------
-- The backend uses the service-role key (which bypasses RLS) and filters by
-- user_id itself. These policies are defense-in-depth so a user can only ever
-- touch their own rows even if queried directly with their anon JWT.
alter table public.models        enable row level security;
alter table public.agents        enable row level security;
alter table public.memory        enable row level security;
alter table public.files         enable row level security;
alter table public.harnesses     enable row level security;
alter table public.provider_keys enable row level security;
alter table public.skills        enable row level security;
alter table public.auto_approvals enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['models','agents','memory','files','harnesses','provider_keys','skills','auto_approvals','conversations','messages'] loop
    execute format('drop policy if exists "own rows" on public.%I;', t);
    execute format(
      'create policy "own rows" on public.%I for all
         using (auth.uid() = user_id) with check (auth.uid() = user_id);', t);
  end loop;
end $$;

-- ---- Storage bucket ----------------------------------------
insert into storage.buckets (id, name, public)
values ('orbital-files', 'orbital-files', false)
on conflict (id) do nothing;

-- Each user can only read/write objects under a folder named with their uid:
--   orbital-files/<user_id>/<file>
drop policy if exists "orbital own files read"   on storage.objects;
drop policy if exists "orbital own files write"  on storage.objects;
drop policy if exists "orbital own files delete" on storage.objects;

create policy "orbital own files read" on storage.objects for select
  using (bucket_id = 'orbital-files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "orbital own files write" on storage.objects for insert
  with check (bucket_id = 'orbital-files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "orbital own files delete" on storage.objects for delete
  using (bucket_id = 'orbital-files' and (storage.foldername(name))[1] = auth.uid()::text);

-- Done. New users are seeded with default models/agents/harnesses by the app
-- on first sign-in (see server/db.js → ensureSeed).
