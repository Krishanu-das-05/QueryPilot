import NewDatasetClient from "@/components/new-dataset-client";

export const dynamic = "force-dynamic";

export default function NewDatasetPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-xl font-bold">New dataset</h1>
      <NewDatasetClient />
    </div>
  );
}
