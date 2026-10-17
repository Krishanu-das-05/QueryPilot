import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAdminDb } from "@/lib/db";
import { checkPassphrase } from "@/lib/guard";

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
  const datasets = await sql`SELECT id FROM datasets WHERE id = ${id}`;
  if (datasets.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const rows = await sql`
    SELECT id, title, created_at FROM conversations
    WHERE dataset_id = ${id} ORDER BY created_at DESC
  `;
  return NextResponse.json(rows);
}
