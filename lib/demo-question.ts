import type postgres from "postgres";
import { DEMO_DATASET_IDS, demoDailyCap } from "./demo";

type Reservation =
  | { ok: true; conversationId: string }
  | { ok: false; status: number; error: string };

export async function reserveDemoQuestion(
  sql: postgres.Sql,
  datasetId: string,
  message: string,
  existingConversationId?: string,
): Promise<Reservation> {
  let cap: number;
  try {
    cap = demoDailyCap();
  } catch {
    return { ok: false, status: 503, error: "Demo question limit is not configured correctly." };
  }
  try {
    return await sql.begin(async (tx): Promise<Reservation> => {
      const ids = [...DEMO_DATASET_IDS];
      const datasets = await tx<{ id: string; status: string; is_demo: boolean }[]>`
        SELECT id, status, is_demo FROM datasets
        WHERE is_demo AND id IN ${tx(ids)}
        ORDER BY id FOR UPDATE
      `;
      const dataset = datasets.find((row) => row.id === datasetId);
      if (!dataset) return { ok: false, status: 404, error: "not found" };
      if (dataset.status !== "ready") {
        return { ok: false, status: 409, error: "dataset is not ready for questions yet" };
      }
      if (existingConversationId) {
        const owned = await tx`
          SELECT id FROM conversations
          WHERE id = ${existingConversationId} AND dataset_id = ${datasetId}
        `;
        if (!owned.length) return { ok: false, status: 404, error: "not found" };
      }
      const [count] = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        JOIN datasets d ON d.id = c.dataset_id
        WHERE d.is_demo AND d.id IN ${tx(ids)} AND m.role = 'user'
          AND m.created_at > now() - interval '24 hours'
      `;
      if (Number(count?.n ?? "0") >= cap) {
        return {
          ok: false,
          status: 429,
          error: "The shared demo question limit has been reached. Please try again later.",
        };
      }
      let conversationId = existingConversationId;
      if (!conversationId) {
        const [created] = await tx<{ id: string }[]>`
          INSERT INTO conversations (dataset_id, title)
          VALUES (${datasetId}, ${message.slice(0, 60)}) RETURNING id
        `;
        if (!created) throw new Error("Could not reserve a demo conversation");
        conversationId = created.id;
      }
      await tx`
        INSERT INTO messages (conversation_id, role, content)
        VALUES (${conversationId}, 'user', ${message})
      `;
      return { ok: true, conversationId };
    });
  } catch {
    return { ok: false, status: 503, error: "Demo questions are temporarily unavailable." };
  }
}
