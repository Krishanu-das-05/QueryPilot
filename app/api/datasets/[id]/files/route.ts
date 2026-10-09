import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAdminDb } from "@/lib/db";
import { UPLOAD_LIMITS } from "@/lib/env";
import { checkPassphrase } from "@/lib/guard";
import { tableNameForFile } from "@/lib/ingest/tableName";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  storagePath: z.string().min(1).max(500),
  originalName: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
});

export async function POST(req: NextRequest, { params }: Params) {
  if (!checkPassphrase(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = schema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const lower = body.data.originalName.toLowerCase();
  if (!UPLOAD_LIMITS.allowedExtensions.some((ext) => lower.endsWith(ext))) {
    return NextResponse.json({ error: "only CSV and XLSX files are allowed" }, { status: 400 });
  }
  if (body.data.sizeBytes > UPLOAD_LIMITS.maxFileBytes) {
    return NextResponse.json({ error: "file exceeds the 10 MB limit" }, { status: 400 });
  }
  if (!body.data.storagePath.startsWith(`${id}/`)) {
    return NextResponse.json({ error: "storage path does not belong to dataset" }, { status: 400 });
  }

  const sql = getAdminDb();
  const existing = await sql<{ table_name: string | null }[]>`
    SELECT table_name FROM dataset_files WHERE dataset_id = ${id}
  `;
  if (existing.length >= UPLOAD_LIMITS.maxFilesPerDataset) {
    return NextResponse.json(
      { error: "a dataset can have at most 5 files" },
      { status: 400 },
    );
  }
  const taken = new Set(existing.map((f) => f.table_name).filter(Boolean) as string[]);
  const tableName = tableNameForFile(body.data.originalName, taken);

  const [row] = await sql<{ id: string; table_name: string }[]>`
    INSERT INTO dataset_files (dataset_id, storage_path, original_name, size_bytes, table_name)
    VALUES (${id}, ${body.data.storagePath}, ${body.data.originalName},
            ${body.data.sizeBytes}, ${tableName})
    RETURNING id, table_name
  `;
  return NextResponse.json({ id: row?.id, tableName: row?.table_name });
}
