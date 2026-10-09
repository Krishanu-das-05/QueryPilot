# Research: Agentic harnesses for a text-to-SQL agent

Purpose: ground the Weekend-2 SQL agent design in published patterns, and
record why QueryPilot owns its harness instead of adopting a framework.
Companion decision records: ADR 0004 (harness), ADR 0005 (guardrails).

## 1. The decomposition: agent = model + harness

A useful mental model (Oracle's enterprise data-agent harness workshop;
Hamza Boughanim, "The Agent Harness: The System Around the LLM"): an LLM alone
is a pure function — tokens in, tokens out. It cannot remember anything between
calls, execute SQL, or see the database. Everything that is *not* the model —
loop, tools, memory, guardrails, sandbox, observability, evaluation — is the
**harness**. The strong claim, borne out repeatedly: a mediocre model in a
well-designed harness beats a frontier model in a bare chat loop.

Harness components and what breaks without each:

| Component | QueryPilot form | Missing → failure mode |
|---|---|---|
| Orchestration | explicit state graph with max-step cap | infinite loops, runaway cost |
| Tools | 5 narrow typed tools (search_catalog, describe_table, top_values, sample_rows, explain_sql) | model guesses schema/columns, hallucinated SQL |
| Memory | conversation rows + trace; catalog as long-term structured memory | no context between turns |
| Guardrails | 6-stage deterministic SQL pipeline | writes/exfil possible |
| Sandbox | `qp_query` role, READ ONLY txn, 5s timeout | one bad query = outage/loss |
| Observability | `messages.tool_trace`, `queries.guard_report` | failures surface via users |
| Evaluation | golden Q/A evals + adversarial suite | silent regressions |

## 2. Orchestration patterns

**ReAct (Reason+Act)**: alternate explicit reasoning with tool calls; stop on
task completion, step cap, or timeout. Simple, robust, and the backbone of most
production loops.

**Explicit state graphs (LangGraph-style)**: nodes as pure-ish functions over
a typed state; edges decide transitions. Wins vs free-form ReAct when the
domain has known structure: text-to-SQL has a nearly fixed pipeline
(link → plan → generate → verify → execute → repair), so an explicit graph
gives determinism, testability per node, and safe iteration budgets. We adopt
the *pattern* (typed `AgentState`, node functions, edge table, traced executor)
without the framework dependency — a decision recorded in ADR 0004.

## 3. Text-to-SQL-specific lessons

**FlexSQL (arXiv 2605.02815)**: flexible database interaction at ANY point —
explore schema, inspect values, run verification queries during reasoning —
plus backtracking from code-level errors to plan-level revisions. Outperforms
stronger models on Spider2-Snow. Takeaway for QueryPilot: do not freeze the
schema slice after one retrieval shot; the repair node may re-invoke
`retrieve`/`plan`, not just regenerate SQL.

**SQL-of-Thought (arXiv 2509.00581)**: multi-agent decomposition (schema
linking, subproblems, query plan, SQL, guided correction) with a
**taxonomy-guided** error-correction loop — correction guided by categorized
failure modes beats execution-only static refinement. Takeaway: our `repair`
node maps guardrail/DB errors to a taxonomy (syntax, unknown identifier, type
mismatch, timeout, permission) and feeds the fix strategy, not just the error
string.

**Guardrail-pipeline practice (vk4868/bigquery-sql-agent)**: the model only
ever produces *text*; deterministic code decides whether it runs. Six stages —
read-only check, table allowlist, row limit, dry-run, cost check, capped
execution — with rejection messages fed back for a bounded number of repair
attempts. AST-based checks (not regex) withstand stacked statements, aliased
CTEs, parameterized limits. Takeaway: adopted almost verbatim as ADR 0005.

**AskTable / PebbleAI**: on-demand metadata loading (start with table names,
fetch detail via tools) beats context-stuffing; structured JSON outputs;
loop-safety limits; streaming for UX.

**OpenAI SchemaFlow cookbook**: stage pipelines with deterministic validation
between LLM stages, producing auditable artifacts. Our `queries.guard_report`
is exactly this artifact.

## 4. Sandboxing model

Two layers, each independently sufficient:

1. **Privileges** (ADR 0003): `qp_query` has NO default privileges; per-dataset
   SELECT via `ds_<shortid>_r`. Catalog stays in `public` (RLS on, no grants).
2. **Pipeline** (ADR 0005): single statement, SELECT-only via AST/EXPLAIN
   dry-run in a rolled-back transaction, schema allowlist, LIMIT injection,
   statement_timeout 5s, row cap 1000, cost heuristics.

`pgBouncer` note: all `SET` must be `SET LOCAL` inside explicit transactions —
session state does not survive the pooler.

## 5. Framework scorecard (for ADR 0004)

| Option | Fits spec? | Notes |
|---|---|---|
| Hand-rolled state graph | yes ("no agent or LLM frameworks") | ~600 LOC, full control, every stage unit-testable |
| Vercel AI SDK | marginal | streaming UX gains, but new framework dep; tool loop hidden |
| LangGraph/LangChain | no | heaviest dep, most magic; pattern is valuable even when the lib is not |
| OpenAI Agents SDK | no | provider lock-in, contradicts OpenRouter choice |

Decision: hand-rolled, LangGraph-shaped. See ADR 0004.

## 6. Evaluation practice

Failures must be caught by tests, not users (harness gap #7). Weekend-2 eval
assets: `evals/agent-golden/` — 25 (question → SQL-shape → expected result)
triples over the eval pair, run with a recorded-LLM replay for CI determinism
plus a live mode; a 40-case adversarial guardrail suite (stacked queries,
comment smuggling, CTE-DML, UNION exfil, `pg_sleep`, cross-schema, limit
weirdness).

## References

- FlexSQL: Flexible Exploration and Execution Make Better Text-to-SQL Agents — arxiv.org/html/2605.02815v2
- SQL-of-Thought: Multi-agentic Text-to-SQL with Guided Error Correction — arxiv.org/pdf/2509.00581
- vk4868/bigquery-sql-agent — six-stage guardrail pipeline, 160 adversarial tests
- oracle-devrel/oracle-ai-developer-hub — enterprise data-agent harness workshop
- H. Boughanim, "The Agent Harness: The System Around the LLM"
- AskTable engineering blog — multi-agent text-to-SQL architecture
- OpenAI Cookbook, SchemaFlow — staged LLM pipelines with deterministic validation
