"use client";

import { createClient } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import { useState } from "react";

const MAX_BYTES = 10 * 1024 * 1024;

type Phase =
  | { kind: "form" }
  | { kind: "uploading"; datasetId: string; current: number; total: number }
  | { kind: "ingesting"; datasetId: string; status: string; progress: number }
  | { kind: "error"; message: string };

async function api(
  path: string,
  passphrase: string,
  body: unknown,
): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-upload-passphrase": passphrase,
    },
    body: JSON.stringify(body),
  });
}

export default function NewDatasetClient() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  async function start() {
    if (!passphrase || !name || files.length === 0) return;
    if (files.length > 5) {
      setPhase({ kind: "error", message: "At most 5 files per dataset." });
      return;
    }
    const bad = files.find(
      (f) =>
        !/\.(csv|xlsx)$/i.test(f.name) || f.size > MAX_BYTES,
    );
    if (bad) {
      setPhase({
        kind: "error",
        message: `${bad.name}: only CSV/XLSX up to 10 MB are allowed.`,
      });
      return;
    }

    const createRes = await api("/api/datasets", passphrase, { name });
    if (!createRes.ok) {
      setPhase({
        kind: "error",
        message: createRes.status === 401 ? "Wrong passphrase." : "Could not create dataset.",
      });
      return;
    }
    const { id: datasetId } = (await createRes.json()) as { id: string };

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      setPhase({ kind: "error", message: "Supabase client env vars are missing." });
      return;
    }
    const supabase = createClient(supabaseUrl, anonKey);

    setPhase({ kind: "uploading", datasetId, current: 0, total: files.length });
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (!file) continue;
      setPhase({ kind: "uploading", datasetId, current: i, total: files.length });

      const urlRes = await api(
        `/api/datasets/${datasetId}/upload-url`,
        passphrase,
        { fileName: file.name, size: file.size },
      );
      if (!urlRes.ok) {
        setPhase({ kind: "error", message: `Upload URL failed for ${file.name}.` });
        return;
      }
      const { path, token } = (await urlRes.json()) as { path: string; token: string };
      const { error: upErr } = await supabase.storage
        .from("uploads")
        .uploadToSignedUrl(path, token, file);
      if (upErr) {
        setPhase({ kind: "error", message: `Upload failed for ${file.name}.` });
        return;
      }
      const regRes = await api(`/api/datasets/${datasetId}/files`, passphrase, {
        storagePath: path,
        originalName: file.name,
        sizeBytes: file.size,
      });
      if (!regRes.ok) {
        setPhase({ kind: "error", message: `Could not register ${file.name}.` });
        return;
      }
    }

    setPhase({ kind: "ingesting", datasetId, status: "uploaded", progress: 0 });
    let status = "uploaded";
    let progress = 0;
    while (status !== "ready" && status !== "failed") {
      const res = await api(`/api/datasets/${datasetId}/ingest/next`, passphrase, {});
      if (!res.ok) {
        setPhase({ kind: "error", message: "Ingestion step failed to run." });
        return;
      }
      const step = (await res.json()) as { status: string; progress: number };
      status = step.status;
      progress = step.progress;
      setPhase({ kind: "ingesting", datasetId, status, progress });
      if (status !== "ready" && status !== "failed") {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    if (status === "ready") {
      router.push(`/datasets/${datasetId}`);
    } else {
      setPhase({ kind: "error", message: "Ingestion failed. See the dataset's error." });
    }
  }

  if (phase.kind === "uploading" || phase.kind === "ingesting") {
    return (
      <div className="rounded border bg-white p-6">
        {phase.kind === "uploading" ? (
          <p>
            Uploading file {phase.current + 1} of {phase.total}…
          </p>
        ) : (
          <div>
            <p className="mb-2">
              Ingesting — status: <span className="font-semibold">{phase.status}</span>
            </p>
            <div className="h-2 w-full rounded bg-gray-200">
              <div
                className="h-2 rounded bg-blue-600 transition-all"
                style={{ width: `${phase.progress}%` }}
              />
            </div>
            <p className="mt-1 text-sm text-gray-600">{phase.progress}%</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded border bg-white p-6">
      {phase.kind === "error" && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{phase.message}</p>
      )}
      <label className="block">
        <span className="text-sm font-medium">Upload passphrase</span>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          className="mt-1 w-full rounded border px-3 py-2"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Dataset name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded border px-3 py-2"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Files (CSV/XLSX, max 5, 10 MB each)</span>
        <input
          type="file"
          multiple
          accept=".csv,.xlsx"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="mt-1 w-full"
        />
      </label>
      <button
        onClick={() => void start()}
        disabled={!passphrase || !name || files.length === 0}
        className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        Upload and ingest
      </button>
    </div>
  );
}
