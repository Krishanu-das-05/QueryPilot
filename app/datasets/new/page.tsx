import NewDatasetClient from "@/components/new-dataset-client";

export const dynamic = "force-dynamic";

export default function NewDatasetPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">New dataset</h1>
        <p className="text-sm text-muted-foreground">
          Upload up to 5 CSV or XLSX files. Files go straight to private
          storage; ingestion runs in bounded steps you can watch live.
        </p>
      </div>
      <NewDatasetClient />
    </div>
  );
}
