"use client";

import { useState } from "react";

interface Props {
  initial: string;
  patch: { datasetId: string; tableId?: string; columnId?: string };
  compact?: boolean;
}

export default function Description({ initial, patch, compact }: Props) {
  const [value, setValue] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  const [message, setMessage] = useState("");

  async function save() {
    const passphrase = window.prompt("Upload passphrase (required to edit):");
    if (passphrase === null) return;
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
    if (res.ok) {
      setValue(draft);
      setEditing(false);
      setMessage("");
    } else {
      setMessage(res.status === 401 ? "Wrong passphrase." : "Save failed.");
    }
  }

  if (!editing) {
    return (
      <button
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className={`text-left ${value ? "text-gray-800" : "italic text-gray-400"} hover:text-blue-700`}
        title="Click to edit"
      >
        {value || (compact ? "add description" : "No description yet — click to add one.")}
        {message && <span className="ml-2 text-xs text-red-600">{message}</span>}
      </button>
    );
  }

  return (
    <span className="block">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={compact ? 2 : 3}
        className="w-full rounded border px-2 py-1 text-sm"
      />
      <span className="mt-1 flex gap-2 text-sm">
        <button
          onClick={() => void save()}
          className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-700"
        >
          Save
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setDraft(value);
          }}
          className="rounded border px-2 py-0.5"
        >
          Cancel
        </button>
        {message && <span className="text-red-600">{message}</span>}
      </span>
    </span>
  );
}
