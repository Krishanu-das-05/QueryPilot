import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const rows = await getAdminDb()`
    SELECT id, title, created_at FROM conversations
    WHERE dataset_id = ${id} ORDER BY created_at DESC
  `;
  return NextResponse.json(rows);
}
