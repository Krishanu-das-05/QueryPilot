import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sql = getAdminDb();
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
