import { MessagesSquare } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Description from "@/components/description";
import RelationshipGraph from "@/components/relationship-graph";
import { getDatasetCatalog } from "@/lib/catalog";

export const dynamic = "force-dynamic";

interface TopValue {
  value: string;
  count: number;
}

export default async function DatasetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const catalog = await getDatasetCatalog(id);
  if (!catalog) notFound();
  const { dataset, tables, columns, relationships, files } = catalog;

  const totalRows = tables.reduce((acc, t) => acc + Number(t.row_count ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{String(dataset.name)}</h1>
          <Badge
            variant={dataset.status === "ready" ? "success" : dataset.status === "failed" ? "destructive" : "warning"}
          >
            {String(dataset.status)}
          </Badge>
          {dataset.status === "ready" && (
            <Button asChild className="ml-auto">
              <Link href={`/datasets/${id}/chat`}>
                <MessagesSquare /> Ask questions
              </Link>
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {files.length} file{files.length === 1 ? "" : "s"} · {tables.length} table
          {tables.length === 1 ? "" : "s"} · {totalRows} rows
          {dataset.error ? ` · error: ${String(dataset.error)}` : ""}
        </p>
      </div>

      <Tabs defaultValue="tables">
        <TabsList>
          <TabsTrigger value="tables">Tables</TabsTrigger>
          <TabsTrigger value="relationships">
            Relationships ({relationships.length})
          </TabsTrigger>
          <TabsTrigger value="overview">Overview</TabsTrigger>
        </TabsList>

        <TabsContent value="tables" className="space-y-6">
          {tables.length === 0 && (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">
                {dataset.status === "ready"
                  ? "No tables were found in this dataset."
                  : "Ingestion has not produced a catalog yet."}
              </CardContent>
            </Card>
          )}
          {tables.map((t) => {
            const cols = columns
              .filter((c) => c.table_id === t.id)
              .sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
            return (
              <Card key={String(t.id)}>
                <CardHeader>
                  <div className="flex items-baseline justify-between gap-2">
                    <CardTitle className="font-mono">{String(t.table_name)}</CardTitle>
                    <CardDescription>
                      {String(t.original_file)} · {String(t.row_count)} rows
                      {t.description_edited ? " · edited" : ""}
                    </CardDescription>
                  </div>
                  <Description
                    initial={(t.description as string | null) ?? ""}
                    patch={{ datasetId: id, tableId: String(t.id) }}
                  />
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  <table className="w-full text-left text-sm">
                    <thead className="border-y text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-5 py-2 font-medium">Column</th>
                        <th className="px-3 py-2 font-medium">Type</th>
                        <th className="px-3 py-2 font-medium">Original</th>
                        <th className="px-3 py-2 font-medium">Null %</th>
                        <th className="px-3 py-2 font-medium">Distinct</th>
                        <th className="px-3 py-2 font-medium">Range / top</th>
                        <th className="px-3 py-2 font-medium">Coerced</th>
                        <th className="px-5 py-2 font-medium">Description</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {cols.map((c) => (
                        <tr key={String(c.id)} className="align-top">
                          <td className="px-5 py-2.5 font-mono text-xs">
                            <span className="text-sm">{String(c.column_name)}</span>
                            {c.is_candidate_key ? (
                              <Badge variant="default" className="ml-2">
                                key
                              </Badge>
                            ) : null}
                          </td>
                          <td className="px-3 py-2.5">
                            <span>{String(c.data_type)}</span>
                            {c.is_percent ? <span className="text-muted-foreground"> %</span> : null}
                            {c.date_format ? (
                              <span className="block text-xs text-muted-foreground">
                                {String(c.date_format)}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground">
                            {String(c.original_header ?? "")}
                          </td>
                          <td className="px-3 py-2.5">
                            <NullBar pct={Number(c.null_pct ?? 0)} />
                          </td>
                          <td className="px-3 py-2.5">{String(c.distinct_count ?? "")}</td>
                          <td className="max-w-[220px] truncate px-3 py-2.5 text-muted-foreground">
                            {c.min_value !== null
                              ? `${String(c.min_value)} – ${String(c.max_value)}`
                              : ((c.top_values as TopValue[] | null) ?? [])
                                  .slice(0, 4)
                                  .map((v) => `${v.value} (${v.count})`)
                                  .join(", ")}
                          </td>
                          <td className="px-3 py-2.5">
                            {Number(c.coerced_count ?? 0) > 0 ? (
                              <span className="text-warning">{String(c.coerced_count)}</span>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                          </td>
                          <td className="max-w-[280px] px-5 py-2.5">
                            <Description
                              initial={(c.description as string | null) ?? ""}
                              patch={{ datasetId: id, columnId: String(c.id) }}
                              compact
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            );
          })}
        </TabsContent>

        <TabsContent value="relationships">
          {relationships.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">
                No relationships were detected between these tables.
              </CardContent>
            </Card>
          ) : (
            <RelationshipGraph
              relationships={relationships.map((r) => ({
                fromTable: String(r.from_table),
                fromColumn: String(r.from_column),
                toTable: String(r.to_table),
                toColumn: String(r.to_column),
                overlap: Number(r.overlap),
                method: String(r.method),
              }))}
            />
          )}
        </TabsContent>

        <TabsContent value="overview">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Files</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-left text-sm">
                <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="py-2 font-medium">File</th>
                    <th className="py-2 font-medium">Size</th>
                    <th className="py-2 font-medium">Table</th>
                    <th className="py-2 font-medium">Rows loaded</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {files.map((f) => (
                    <tr key={String(f.id)}>
                      <td className="py-2">{String(f.original_name)}</td>
                      <td className="py-2 text-muted-foreground">
                        {Math.round(Number(f.size_bytes ?? 0) / 1024)} KB
                      </td>
                      <td className="py-2 font-mono text-xs">{String(f.table_name ?? "")}</td>
                      <td className="py-2">
                        {String(f.rows_loaded ?? 0)} / {String(f.row_count ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-4 text-xs text-muted-foreground">
                Created {new Date(String(dataset.created_at)).toLocaleString()} · expires{" "}
                {new Date(String(dataset.expires_at)).toLocaleDateString()}
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function NullBar({ pct }: { pct: number }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <span
          className={`block h-full rounded-full ${pct > 25 ? "bg-warning" : "bg-success"}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </span>
      <span className="text-xs text-muted-foreground">{pct}%</span>
    </span>
  );
}
