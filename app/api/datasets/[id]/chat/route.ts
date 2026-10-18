import { NextRequest } from "next/server";
import { z } from "zod";
import { loadCatalog } from "@/lib/agent/catalog";
import { explainAsQueryRole, executeAsQueryRole } from "@/lib/agent/deps";
import { runAgent } from "@/lib/agent/executor";
import { createOpenRouterLlm } from "@/lib/agent/llm";
import { AGENT_DAILY_CAP, type AgentState } from "@/lib/agent/state";
import { getAdminDb } from "@/lib/db";
import { checkPassphrase } from "@/lib/guard";
import { isDemoDeployment, isVisibleDataset } from "@/lib/demo";
import { reserveDemoQuestion } from "@/lib/demo-question";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const uuidSchema = z.string().uuid();
const bodySchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1).max(2000),
});

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest, { params }: Params) {
  const demo = isDemoDeployment();
  if (!demo && !checkPassphrase(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  const { id: datasetId } = await params;
  if (!uuidSchema.safeParse(datasetId).success) {
    return new Response(JSON.stringify({ error: "invalid request" }), { status: 400 });
  }
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return new Response(JSON.stringify({ error: "invalid request" }), { status: 400 });
  }

  const sql = getAdminDb();
  const datasets = await sql<{ id: string; status: string; is_demo: boolean }[]>`
    SELECT id, status, is_demo FROM datasets WHERE id = ${datasetId}
  `;
  const dataset = datasets[0];
  if (!dataset || !isVisibleDataset(dataset)) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }
  if (dataset.status !== "ready") {
    return new Response(
      JSON.stringify({ error: "dataset is not ready for questions yet" }),
      { status: 409 },
    );
  }

  if (!demo && body.data.conversationId) {
    const owned = await sql<{ id: string }[]>`
      SELECT id FROM conversations WHERE id = ${body.data.conversationId} AND dataset_id = ${datasetId}
    `;
    if (owned.length === 0) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
  }

  // daily cap: count user questions today for this dataset
  if (!demo) {
    const capRows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.dataset_id = ${datasetId} AND m.role = 'user'
        AND m.created_at > now() - interval '24 hours'
    `;
    if (Number(capRows[0]?.n ?? "0") >= AGENT_DAILY_CAP) {
      return new Response(
        JSON.stringify({ error: "daily question limit reached for this dataset" }),
        { status: 429 },
      );
    }
  }

  const catalog = await loadCatalog(sql, datasetId);
  if (!catalog) {
    return new Response(JSON.stringify({ error: "no catalog for dataset" }), { status: 409 });
  }

  // conversation: create or validate
  let conversationId = body.data.conversationId ?? null;
  if (demo) {
    const reservation = await reserveDemoQuestion(
      sql, datasetId, body.data.message, body.data.conversationId,
    );
    if (!reservation.ok) {
      return new Response(JSON.stringify({ error: reservation.error }), { status: reservation.status });
    }
    conversationId = reservation.conversationId;
  } else {
    if (!conversationId) {
      const title = body.data.message.slice(0, 60);
      const [c] = await sql<{ id: string }[]>`
        INSERT INTO conversations (dataset_id, title) VALUES (${datasetId}, ${title})
        RETURNING id
      `;
      conversationId = c!.id;
    }
    await sql`
      INSERT INTO messages (conversation_id, role, content)
      VALUES (${conversationId}, 'user', ${body.data.message})
    `;
  }

  const encoder = new TextEncoder();
  const started = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sse(event, data)));
      };
      send("conversation", { id: conversationId });
      try {
        const deps = {
          llm: createOpenRouterLlm(),
          explain: (q: string) => explainAsQueryRole(catalog.schemaName, catalog.roleName, q),
          execute: (q: string) => executeAsQueryRole(catalog.schemaName, catalog.roleName, q),
          emit: (event: string, data: unknown) => {
            if (event === "sql" || event === "rows" || event === "trace") send(event, data);
          },
        };
        const initial: AgentState = {
          question: body.data.message,
          datasetId,
          schemaName: catalog.schemaName,
          catalog: catalog.tables,
          relationships: catalog.relationships,
          slice: null,
          answer: null,
          sql: null,
          result: null,
          guard: { sql: null, report: [], repairAttempts: 0, repairHistory: [] },
          trace: [],
          status: "working",
          error: null,
        };
        const final = await runAgent(initial, deps);

        // persist assistant message + query audit
        await sql`
          INSERT INTO messages (conversation_id, role, content, tool_trace)
          VALUES (
            ${conversationId}, 'assistant', ${final.answer},
            ${sql.json({ trace: final.trace, status: final.status } as never)}
          )
        `;
        if (final.guard.sql) {
          await sql`
            INSERT INTO queries (
              conversation_id, dataset_id, sql_text, status, guard_report,
              row_count, elapsed_ms, error
            ) VALUES (
              ${conversationId}, ${datasetId}, ${final.guard.sql},
              ${final.status === "answered" ? "executed" : final.status === "failed" ? "failed" : "rejected"},
              ${sql.json(final.guard.report as never)},
              ${final.result?.rows.length ?? null},
              ${final.result?.elapsedMs ?? null},
              ${final.error}
            )
          `;
        }

        send("answer", {
          text: final.answer,
          status: final.status,
          columns: final.result?.columns ?? [],
          rows: (final.result?.rows ?? []).slice(0, 1000),
          truncated: final.result?.truncated ?? false,
        });
        send("done", { conversationId, elapsedMs: Date.now() - started });
      } catch {
        send("error", {
          category: "internal",
          message: "Something went wrong. Please try again.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
