import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/db";
import { checkPassphrase } from "@/lib/guard";
import { runIngestStep } from "@/lib/ingest/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  if (!checkPassphrase(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const sql = getAdminDb();
  const datasets = await sql`SELECT id FROM datasets WHERE id = ${id}`;
  if (datasets.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const result = await runIngestStep(id);
  return NextResponse.json(result);
}
