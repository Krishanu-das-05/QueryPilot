import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAdminDb } from "@/lib/db";
import { UPLOAD_LIMITS } from "@/lib/env";
import { checkPassphrase } from "@/lib/guard";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { DEMO_WRITE_ERROR, isDemoDeployment } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  fileName: z.string().min(1).max(255),
  size: z.number().int().positive(),
});

export async function POST(req: NextRequest, { params }: Params) {
  if (isDemoDeployment()) {
    return NextResponse.json({ error: DEMO_WRITE_ERROR }, { status: 403 });
  }
  if (!checkPassphrase(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = schema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const lower = body.data.fileName.toLowerCase();
  if (!UPLOAD_LIMITS.allowedExtensions.some((ext) => lower.endsWith(ext))) {
    return NextResponse.json({ error: "only CSV and XLSX files are allowed" }, { status: 400 });
  }
  if (body.data.size > UPLOAD_LIMITS.maxFileBytes) {
    return NextResponse.json({ error: "file exceeds the 10 MB limit" }, { status: 400 });
  }

  const sql = getAdminDb();
  const datasets = await sql`SELECT id FROM datasets WHERE id = ${id}`;
  if (datasets.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const countRows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM dataset_files WHERE dataset_id = ${id}
  `;
  if (Number(countRows[0]?.count ?? "0") >= UPLOAD_LIMITS.maxFilesPerDataset) {
    return NextResponse.json(
      { error: "a dataset can have at most 5 files" },
      { status: 400 },
    );
  }

  const safeName = body.data.fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  const path = `${id}/${crypto.randomUUID()}-${safeName}`;
  const { data, error } = await getSupabaseAdmin()
    .storage.from("uploads")
    .createSignedUploadUrl(path);
  if (error || !data) {
    return NextResponse.json(
      { error: "could not create upload url" },
      { status: 500 },
    );
  }
  return NextResponse.json({ path: data.path, token: data.token });
}
