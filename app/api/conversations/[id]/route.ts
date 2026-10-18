import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAdminDb } from "@/lib/db";
import { checkPassphrase } from "@/lib/guard";
import { isVisibleDataset } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidSchema = z.string().uuid();

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!checkPassphrase(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const sql = getAdminDb();
  const owned = await sql`
    SELECT c.id, d.id AS dataset_id, d.is_demo FROM conversations c JOIN datasets d ON d.id = c.dataset_id
    WHERE c.id = ${id}
  `;
  if (owned.length === 0 || !isVisibleDataset({ id: owned[0]?.dataset_id, is_demo: owned[0]?.is_demo })) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const messages = await sql`
    SELECT id, role, content, tool_trace, created_at
    FROM messages WHERE conversation_id = ${id} ORDER BY created_at
  `;
  const queries = await sql`
    SELECT id, sql_text, status, guard_report, row_count, elapsed_ms, error, created_at
    FROM queries WHERE conversation_id = ${id} ORDER BY created_at
  `;
  return NextResponse.json({ messages, queries });
}
