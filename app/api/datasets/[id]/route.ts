import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDatasetCatalog } from "@/lib/catalog";
import { getAdminDb } from "@/lib/db";
import { checkPassphrase } from "@/lib/guard";
import { DEMO_WRITE_ERROR, isDemoDeployment } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const catalog = await getDatasetCatalog(id);
  if (!catalog) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(catalog);
}

const patchSchema = z
  .object({
    tableId: z.string().uuid().optional(),
    columnId: z.string().uuid().optional(),
    description: z.string().max(2000),
  })
  .refine((v) => (v.tableId ? !v.columnId : !!v.columnId), {
    message: "exactly one of tableId/columnId required",
  });

export async function PATCH(req: NextRequest, { params }: Params) {
  if (isDemoDeployment()) {
    return NextResponse.json({ error: DEMO_WRITE_ERROR }, { status: 403 });
  }
  if (!checkPassphrase(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = patchSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const sql = getAdminDb();
  if (body.data.tableId) {
    await sql`
      UPDATE catalog_tables
      SET description = ${body.data.description},
          description_edited = true,
          search = to_tsvector('english',
            coalesce(table_name, '') || ' ' || ${body.data.description})
      WHERE id = ${body.data.tableId} AND dataset_id = ${id}
    `;
  } else if (body.data.columnId) {
    await sql`
      UPDATE catalog_columns c
      SET description = ${body.data.description},
          search = to_tsvector('english',
            coalesce(c.column_name, '') || ' ' || coalesce(c.original_header, '')
            || ' ' || ${body.data.description})
      FROM catalog_tables t
      WHERE c.id = ${body.data.columnId} AND c.table_id = t.id AND t.dataset_id = ${id}
    `;
  }
  return NextResponse.json({ ok: true });
}
