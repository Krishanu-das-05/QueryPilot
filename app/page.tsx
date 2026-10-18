import { Database, FilePlus2, FileSpreadsheet, Rows3 } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminDb } from "@/lib/db";
import { isDemoDeployment, isVisibleDataset } from "@/lib/demo";

export const dynamic = "force-dynamic";

interface Row {
  id: string;
  name: string;
  status: string;
  created_at: string;
  expires_at: string;
  tables: number;
  rows_total: string;
  files: number;
  is_demo: boolean;
}

const STATUS_META: Record<
  string,
  { variant: "secondary" | "warning" | "success" | "destructive"; blink?: boolean }
> = {
  uploaded: { variant: "secondary" },
  profiling: { variant: "warning", blink: true },
  loading: { variant: "warning", blink: true },
  describing: { variant: "warning", blink: true },
  ready: { variant: "success" },
  failed: { variant: "destructive" },
};

export default async function Home() {
  const rows = await getAdminDb()<Row[]>`
    SELECT d.id, d.name, d.status, d.created_at, d.expires_at, d.is_demo,
           (SELECT count(*) FROM catalog_tables t WHERE t.dataset_id = d.id)::int AS tables,
           (SELECT coalesce(sum(t.row_count), 0)::text FROM catalog_tables t WHERE t.dataset_id = d.id) AS rows_total,
           (SELECT count(*) FROM dataset_files f WHERE f.dataset_id = d.id)::int AS files
    FROM datasets d
    ORDER BY d.created_at DESC
  `;
  const datasets = rows.filter(isVisibleDataset);
  const demo = isDemoDeployment();

  return (
    <div className="space-y-10">
      <section className="space-y-4 pt-6">
        <h1 className="text-3xl font-bold tracking-tight">
          Ask your spreadsheet anything.
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          QueryPilot is an agentic data analyst for your own spreadsheets — RAG
          for tables. Upload CSVs or Excel files and it profiles every column,
          infers the real types behind messy formatting, loads the data into its
          own isolated Postgres schema, detects relationships between tables,
          and builds a searchable catalog that an SQL agent uses to answer your
          questions — with the query it ran, shown.
        </p>
        <div className="flex gap-3">
          {!demo && <Button asChild>
            <Link href="/datasets/new">
              <FilePlus2 /> New dataset
            </Link>
          </Button>}
          {datasets.length > 0 && (
            <Button variant="outline" asChild>
              <Link href="#datasets">Browse datasets</Link>
            </Button>
          )}
        </div>
      </section>

      <section id="datasets" className="space-y-4">
        <h2 className="text-lg font-semibold">Datasets</h2>
        {datasets.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <FileSpreadsheet className="h-10 w-10 text-muted-foreground" />
              <p className="text-muted-foreground">
                No datasets yet — upload your first CSV or Excel file.
              </p>
              {!demo && <Button asChild>
                <Link href="/datasets/new">Upload files</Link>
              </Button>}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {datasets.map((d) => {
              const meta = STATUS_META[d.status] ?? { variant: "secondary" as const };
              return (
                <Link key={d.id} href={`/datasets/${d.id}`}>
                  <Card className="h-full transition-colors hover:border-accent/50">
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between gap-2">
                        <CardTitle className="truncate text-base">{d.name}</CardTitle>
                        <Badge variant={meta.variant} className={meta.blink ? "qp-blink" : ""}>
                          {d.status}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <FileSpreadsheet className="h-4 w-4" />
                        {d.files} file{d.files === 1 ? "" : "s"}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Database className="h-4 w-4" />
                        {d.tables} table{d.tables === 1 ? "" : "s"}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Rows3 className="h-4 w-4" />
                        {d.rows_total} rows
                      </span>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
