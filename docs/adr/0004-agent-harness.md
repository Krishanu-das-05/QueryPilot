# ADR 0004: Hand-rolled, LangGraph-shaped agent harness

## Context

Weekend 2 adds a text-to-SQL agent. The original project mandate says "No
agent or LLM frameworks." Published evidence (see
docs/research/agentic-harnesses.md) shows harness quality — not framework
branding — dominates agent outcomes, and that the highest-leverage patterns
are: explicit state graphs (LangGraph-style), narrow typed tools, taxonomy-
guided repair, and deterministic guardrails deciding what may execute.

## Decision

Build the harness ourselves (~600 LOC in `lib/agent/`) on the LangGraph
*pattern* without the framework:

- A zod-typed `AgentState` threaded through nodes
- Nodes as pure-ish functions with injected deps (`llm`, `sql`, `catalog`,
  `clock`) so every node is unit-testable offline
- An edge table + executor with a hard step cap (12) and per-node tracing
  persisted to `messages.tool_trace`
- The `openai` SDK pointed at OpenRouter is the only LLM dependency (same as
  Weekend 1's describer)

Explicitly rejected:

- **LangChain/LangGraph**: violated the mandate; heavy dependency tree; the
  value we want (explicit graphs + tracing) cheaply reproducible.
- **Vercel AI SDK**: attractive streaming ergonomics but hides the tool loop
  behind framework semantics and adds a framework dep we don't otherwise need.
- **OpenAI Agents SDK**: provider lock-in against the OpenRouter strategy.

## Consequences

- Every stage is inspectable and replayable (golden evals with a scripted LLM
  stub can drive the executor deterministically in CI).
- Upgrading/swapping LLM providers touches only `lib/agent/llm.ts`.
- If we ever outgrow it, the state graph maps one-to-one onto LangGraph
  concepts, so migration is mechanical.
- Cost: we own SSE plumbing and retries (~150 LOC) that frameworks give free.
