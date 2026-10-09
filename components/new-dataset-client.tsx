"use client";

import { createClient } from "@supabase/supabase-js";
import {
  Check,
  CircleDashed,
  FileSpreadsheet,
  KeyRound,
  Loader2,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = /\.(csv|xlsx)$/i;

const STEPS = ["uploaded", "profiling", "loading", "describing", "ready"] as const;
const STEP_LABELS: Record<string, string> = {
  uploaded: "Files stored",
  profiling: "Profiling columns",
  loading: "Loading rows",
  describing: "Writing descriptions",
  ready: "Ready",
};

type Phase =
  | { kind: "form" }
  | { kind: "uploading"; current: number; total: number }
  | { kind: "ingesting"; status: string; progress: number }
  | { kind: "error"; message: string };

async function api(path: string, passphrase: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-upload-passphrase": passphrase },
    body: JSON.stringify(body),
  });
}

export default function NewDatasetClient() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const inputRef = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList | File[]) {
    const next = [...files];
    for (const f of Array.from(list)) {
      if (next.length >= 5) {
        toast.error("At most 5 files per dataset.");
        break;
      }
      if (!ACCEPTED.test(f.name)) {
        toast.error(`${f.name}: only CSV and XLSX are supported.`);
        continue;
      }
      if (f.size > MAX_BYTES) {
        toast.error(`${f.name}: exceeds the 10 MB limit.`);
        continue;
      }
      next.push(f);
    }
    setFiles(next);
  }

  async function start() {
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

    setPhase({ kind: "uploading", current: 0, total: files.length });
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (!file) continue;
      setPhase({ kind: "uploading", current: i, total: files.length });
      const urlRes = await api(`/api/datasets/${datasetId}/upload-url`, passphrase, {
        fileName: file.name,
        size: file.size,
      });
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

    setPhase({ kind: "ingesting", status: "uploaded", progress: 0 });
    let status = "uploaded";
    let progress = 0;
    while (status !== "ready" && status !== "failed") {
      const res = await api(`/api/datasets/${datasetId}/ingest/next`, passphrase, {});
      if (!res.ok) {
        setPhase({ kind: "error", message: "An ingestion step failed to run." });
        return;
      }
      const step = (await res.json()) as { status: string; progress: number };
      status = step.status;
      progress = step.progress;
      setPhase({ kind: "ingesting", status, progress });
      if (status !== "ready" && status !== "failed") {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    if (status === "ready") {
      toast.success("Dataset is ready.");
      router.push(`/datasets/${datasetId}`);
    } else {
      setPhase({ kind: "error", message: "Ingestion failed — see the dataset for the error." });
    }
  }

  if (phase.kind === "uploading" || phase.kind === "ingesting") {
    return <ProgressView phase={phase} files={files} />;
  }

  return (
    <div className="space-y-6">
      {phase.kind === "error" && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-2 py-3 text-sm text-destructive">
            <X className="h-4 w-4" /> {phase.message}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-muted-foreground" /> Access & name
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="text-sm text-muted-foreground">Upload passphrase</span>
            <Input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Temporary gate"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm text-muted-foreground">Dataset name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Q3 sales export"
            />
          </label>
        </CardContent>
      </Card>

      <Card
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
        className={cn(
          "border-dashed transition-colors",
          dragOver && "border-accent bg-accent-soft/50",
        )}
      >
        <CardContent
          className="flex cursor-pointer flex-col items-center gap-3 py-10 text-center"
          onClick={() => inputRef.current?.click()}
        >
          <UploadCloud className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="font-medium">Drop CSV or XLSX files here, or click to browse</p>
            <p className="text-sm text-muted-foreground">Up to 5 files, 10 MB each</p>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".csv,.xlsx"
            className="hidden"
            onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
          />
        </CardContent>
      </Card>

      {files.length > 0 && (
        <Card>
          <CardContent className="divide-y py-0">
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} className="flex items-center gap-3 py-3 text-sm">
                <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{f.name}</span>
                <span className="ml-auto text-muted-foreground">
                  {(f.size / 1024).toFixed(0)} KB
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="remove file"
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}
                >
                  <X />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Button
        size="lg"
        onClick={() => void start()}
        disabled={!passphrase || !name || files.length === 0}
      >
        <Sparkles /> Upload and ingest
      </Button>
    </div>
  );
}

function ProgressView({
  phase,
  files,
}: {
  phase: Extract<Phase, { kind: "uploading" | "ingesting" }>;
  files: File[];
}) {
  if (phase.kind === "uploading") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-10">
          <Loader2 className="h-8 w-8 animate-spin text-accent" />
          <p className="font-medium">
            Uploading {files[phase.current]?.name ?? ""} ({phase.current + 1}/{phase.total})
          </p>
          <Progress value={((phase.current + 1) / phase.total) * 100} className="max-w-sm" />
        </CardContent>
      </Card>
    );
  }
  const idx = STEPS.indexOf(phase.status as (typeof STEPS)[number]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-accent" /> Ingesting your data
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          {STEPS.slice(1).map((s, i) => {
            const stepIdx = i + 1;
            const done = idx > stepIdx;
            const active = idx === stepIdx;
            return (
              <div key={s} className="flex items-center gap-3">
                {done ? (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success/15">
                    <Check className="h-4 w-4 text-success" />
                  </span>
                ) : active ? (
                  <Loader2 className="h-6 w-6 animate-spin text-accent" />
                ) : (
                  <CircleDashed className="h-6 w-6 text-muted-foreground" />
                )}
                <span
                  className={cn(
                    "text-sm",
                    active ? "font-medium" : "text-muted-foreground",
                    done && "text-foreground",
                  )}
                >
                  {STEP_LABELS[s]}
                </span>
                {active && (
                  <Badge variant="warning" className="ml-auto">
                    {phase.progress}%
                  </Badge>
                )}
              </div>
            );
          })}
        </div>
        <Progress value={phase.progress} />
      </CardContent>
    </Card>
  );
}
