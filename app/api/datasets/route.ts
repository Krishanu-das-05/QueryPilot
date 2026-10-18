import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAdminDb } from "@/lib/db";
import { checkPassphrase } from "@/lib/guard";
import { DEMO_WRITE_ERROR, isDemoDeployment, isVisibleDataset } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({ name: z.string().min(1).max(200) });

export async function POST(req: NextRequest) {
  if (isDemoDeployment()) {
    return NextResponse.json({ error: DEMO_WRITE_ERROR }, { status: 403 });
  }
  if (!checkPassphrase(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = createSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const sql = getAdminDb();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO datasets (name, status) VALUES (${body.data.name}, 'uploaded')
    RETURNING id
  `;
  return NextResponse.json({ id: row?.id });
}

export async function GET() {
  const sql = getAdminDb();
  const rows = await sql`
    SELECT id, name, status, error, is_demo, created_at, expires_at
    FROM datasets ORDER BY created_at DESC
  `;
  return NextResponse.json(rows.filter(isVisibleDataset));
}
