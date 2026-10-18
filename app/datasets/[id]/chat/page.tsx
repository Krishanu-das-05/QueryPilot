import { notFound, redirect } from "next/navigation";
import ChatClient from "@/components/chat-client";
import { getAdminDb } from "@/lib/db";
import { isDemoDeployment, isVisibleDataset } from "@/lib/demo";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const datasets = await getAdminDb()<
    { id: string; name: string; status: string; is_demo: boolean }[]
  >`
    SELECT id, name, status, is_demo FROM datasets WHERE id = ${id}
  `;
  const dataset = datasets[0];
  if (!dataset || !isVisibleDataset(dataset)) notFound();
  if (dataset.status !== "ready") redirect(`/datasets/${id}`);

  const tables = await getAdminDb()<{ table_name: string; description: string | null }[]>`
    SELECT table_name, description FROM catalog_tables
    WHERE dataset_id = ${id} ORDER BY table_name
  `;

  return <ChatClient datasetId={id} datasetName={dataset.name} tables={tables} demo={isDemoDeployment()} />;
}
