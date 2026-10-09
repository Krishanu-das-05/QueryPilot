import { getDatasetCatalog } from "@/lib/catalog";
import Description from "@/components/description";
import Link from "next/link";
import { notFound } from "next/navigation";

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

  return (
    <div className="space-y-8">
      <div>
        <Link href="/" className="text-sm text-blue-600 underline">
          ← all datasets
        </Link>
        <h1 className="mt-1 text-2xl font-bold">{String(dataset.name)}</h1>
        <p className="text-sm text-gray-600">
          status: <span className="font-medium">{String(dataset.status)}</span>
          {dataset.error ? ` — ${String(dataset.error)}` : ""}
        </p>
        <p className="text-sm text-gray-600">
          files: {files.map((f) => String(f.original_name)).join(", ")}
        </p>
      </div>

      {tables.map((t) => {
        const cols = columns.filter((c) => c.table_id === t.id);
        return (
          <section key={String(t.id)} className="rounded border bg-white">
            <div className="border-b px-4 py-3">
              <h2 className="font-mono text-lg font-semibold">
                {String(t.table_name)}
              </h2>
              <p className="text-sm text-gray-600">
                {String(t.original_file)} — {String(t.row_count)} rows
                {t.description_edited ? " (edited)" : ""}
              </p>
              <Description
                initial={(t.description as string | null) ?? ""}
                patch={{ datasetId: id, tableId: String(t.id) }}
              />
            </div>
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-2">Column</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Original header</th>
                  <th className="px-4 py-2">Null %</th>
                  <th className="px-4 py-2">Distinct</th>
                  <th className="px-4 py-2">Min – max / top values</th>
                  <th className="px-4 py-2">Coerced</th>
                  <th className="px-4 py-2">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {cols.map((c) => (
                  <tr key={String(c.id)} className="align-top">
                    <td className="px-4 py-2 font-mono">
                      {String(c.column_name)}
                      {c.is_candidate_key ? (
                        <span className="ml-1 rounded bg-blue-100 px-1 text-xs text-blue-800">
                          key
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2">
                      {String(c.data_type)}
                      {c.is_percent ? " (%)" : ""}
                      {c.date_format ? (
                        <span className="block text-xs text-gray-500">
                          {String(c.date_format)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {String(c.original_header ?? "")}
                    </td>
                    <td className="px-4 py-2">{String(c.null_pct ?? 0)}</td>
                    <td className="px-4 py-2">{String(c.distinct_count ?? "")}</td>
                    <td className="max-w-xs px-4 py-2 text-gray-600">
                      {c.min_value !== null
                        ? `${String(c.min_value)} – ${String(c.max_value)}`
                        : ((c.top_values as TopValue[] | null) ?? [])
                            .slice(0, 5)
                            .map((v) => `${v.value} (${v.count})`)
                            .join(", ")}
                    </td>
                    <td className="px-4 py-2">{String(c.coerced_count ?? 0)}</td>
                    <td className="max-w-sm px-4 py-2">
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
          </section>
        );
      })}

      {relationships.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Detected relationships</h2>
          <ul className="divide-y rounded border bg-white">
            {relationships.map((r, i) => (
              <li key={i} className="px-4 py-2 font-mono text-sm">
                {String(r.from_table)}.{String(r.from_column)} →{" "}
                {String(r.to_table)}.{String(r.to_column)}
                <span className="ml-2 text-gray-500">
                  overlap {Math.round(Number(r.overlap) * 100)}% ({String(r.method)})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
