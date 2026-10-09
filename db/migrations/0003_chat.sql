-- 0003_chat.sql — conversations, messages, and the auditable query log for
-- the Weekend-2 SQL agent (see docs/lld/agent.md, ADR 0006).

CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES public.datasets(id) ON DELETE CASCADE,
  title text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text,
  tool_trace jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES public.datasets(id) ON DELETE CASCADE,
  sql_text text,
  status text NOT NULL CHECK (status IN
    ('planned', 'guarded', 'executed', 'rejected', 'failed', 'repaired')),
  guard_report jsonb,
  row_count integer,
  elapsed_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON public.messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS queries_conversation_idx
  ON public.queries (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS conversations_dataset_idx
  ON public.conversations (dataset_id, created_at DESC);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queries ENABLE ROW LEVEL SECURITY;
