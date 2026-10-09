import { notFound, redirect } from "next/navigation";
import ChatClient from "@/components/chat-client";
import { getAdminDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const datasets = await getAdminDb()<
    { id: string; name: string; status: string }[]
  >`
    SELECT id, name, status FROM datasets WHERE id = ${id}
  `;
  const dataset = datasets[0];
  if (!dataset) notFound();
  if (dataset.status !== "ready") redirect(`/datasets/${id}`);

  const tables = await getAdminDb()<{ table_name: string; description: string | null }[]>`
    SELECT table_name, description FROM catalog_tables
    WHERE dataset_id = ${id} ORDER BY table_name
  `;

  return <ChatClient datasetId={id} datasetName={dataset.name} tables={tables} />;
}
