"use client";

import { KeyRound, Pencil } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";

interface Props {
  initial: string;
  patch: { datasetId: string; tableId?: string; columnId?: string };
  compact?: boolean;
}

export default function Description({ initial, patch, compact }: Props) {
  const [value, setValue] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!passphrase) {
      toast.error("Enter the upload passphrase to save.");
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/datasets/${patch.datasetId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-upload-passphrase": passphrase,
      },
      body: JSON.stringify({
        tableId: patch.tableId,
        columnId: patch.columnId,
        description: draft,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setValue(draft);
      setEditing(false);
      toast.success("Description saved.");
    } else {
      toast.error(res.status === 401 ? "Wrong passphrase." : "Save failed.");
    }
  }

  if (!editing) {
    return (
      <button
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className={`group inline-flex items-start gap-1.5 text-left text-sm ${
          value ? "text-foreground" : "italic text-muted-foreground"
        } hover:text-accent`}
        title="Click to edit"
      >
        {value || (compact ? "add description" : "No description yet — click to add one.")}
        <Pencil className="mt-0.5 h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
      </button>
    );
  }

  return (
    <span className="block space-y-2">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={compact ? 2 : 3}
        autoFocus
      />
      <span className="flex flex-wrap items-center gap-2">
        <span className="relative">
          <KeyRound className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="passphrase"
            className="h-8 w-36 rounded-md border border-input bg-transparent pl-7 pr-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </span>
        <Button size="sm" onClick={() => void save()} disabled={busy}>
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setEditing(false);
            setDraft(value);
          }}
        >
          Cancel
        </Button>
      </span>
    </span>
  );
}
