import Link from "next/link";
import { getAdminDb } from "@/lib/db";

export const dynamic = "force-dynamic";

interface DatasetListRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
  expires_at: string;
}

const STATUS_STYLES: Record<string, string> = {
  uploaded: "bg-gray-100 text-gray-700",
  profiling: "bg-yellow-100 text-yellow-800",
  loading: "bg-yellow-100 text-yellow-800",
  describing: "bg-yellow-100 text-yellow-800",
  ready: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

export default async function Home() {
  const datasets = await getAdminDb()<DatasetListRow[]>`
    SELECT id, name, status, created_at, expires_at
    FROM datasets ORDER BY created_at DESC
  `;

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-bold">QueryPilot</h1>
        <p className="mt-2 max-w-2xl text-gray-700">
          QueryPilot is an agentic data analyst for your spreadsheets — RAG for
          tables. Upload CSVs or Excel files and QueryPilot profiles every
          column, infers real types behind messy formatting, loads the data
          into its own isolated database schema, finds relationships between
          your tables, and builds a searchable catalog that an SQL agent (coming
          next) will use to answer your questions.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Datasets</h2>
        {datasets.length === 0 ? (
          <p className="text-gray-600">
            No datasets yet.{" "}
            <Link href="/datasets/new" className="text-blue-600 underline">
              Upload your first files
            </Link>
            .
          </p>
        ) : (
          <ul className="divide-y rounded border bg-white">
            {datasets.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/datasets/${d.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-gray-50"
                >
                  <span className="font-medium">{d.name}</span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[d.status] ?? "bg-gray-100"}`}
                  >
                    {d.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
