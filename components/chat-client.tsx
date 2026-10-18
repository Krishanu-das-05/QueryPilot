"use client";

import { ClipboardCopy, Database, KeyRound, Loader2, Send } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Message {
  role: "user" | "assistant";
  content: string;
  sql?: string | null;
  guardReport?: { stage: string; pass: boolean; reason?: string }[];
  columns?: string[];
  rows?: unknown[][];
  truncated?: boolean;
  status?: string;
}

const STARTERS = [
  "Summarize this dataset for me",
  "Show the top 5 rows by the largest amount",
  "Which values are most common in each text column?",
];

export default function ChatClient({
  datasetId,
  datasetName,
  tables,
  demo = false,
}: {
  datasetId: string;
  datasetName: string;
  tables: { table_name: string; description: string | null }[];
  demo?: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  function scrollDown() {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    const q = question.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", content: q }]);
    setBusy(true);
    scrollDown();

    try {
      const res = await fetch(`/api/datasets/${datasetId}/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-upload-passphrase": passphrase,
        },
        body: JSON.stringify({ conversationId: conversationId ?? undefined, message: q }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `request failed (${res.status})`);
      }
      if (!res.body) throw new Error("no response stream");

      const pending: Message = { role: "assistant", content: "" };
      setMessages((m) => [...m, pending]);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const apply = (event: string, data: Record<string, unknown>) => {
        if (event === "conversation") {
          setConversationId(String(data.id));
          return;
        }
        if (event === "sql") {
          pending.sql = String(data.text ?? "");
          pending.guardReport = data.guardReport as Message["guardReport"];
        } else if (event === "rows") {
          pending.truncated = Boolean(data.truncated);
        } else if (event === "answer") {
          pending.content = String(data.text ?? "");
          pending.status = String(data.status ?? "answered");
          pending.columns = (data.columns as string[]) ?? [];
          pending.rows = (data.rows as unknown[][]) ?? [];
          pending.truncated = Boolean(data.truncated);
        } else if (event === "error") {
          pending.content = `Something went wrong: ${String(data.message ?? "unknown")}`;
          pending.status = "failed";
        }
        setMessages((m) => [...m.slice(0, -1), { ...pending }]);
        scrollDown();
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const ev = /^event: (.+)$/m.exec(part)?.[1];
          const dataLine = /^data: (.+)$/m.exec(part)?.[1];
          if (ev && dataLine) {
            try {
              apply(ev, JSON.parse(dataLine) as Record<string, unknown>);
            } catch {
              // ignore malformed event
            }
          }
        }
      }
      if (!pending.content) {
        pending.content = "No answer came back from the agent.";
        setMessages((m) => [...m.slice(0, -1), { ...pending }]);
      }
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content:
            err instanceof Error ? err.message : "Something went wrong asking the agent.",
          status: "failed",
        },
      ]);
      if (passphrase === "") toast.error("Enter the upload passphrase to ask questions.");
    } finally {
      setBusy(false);
      scrollDown();
    }
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{datasetName}</h1>
          <p className="text-sm text-muted-foreground">
            <Link href={`/datasets/${datasetId}`} className="text-accent underline-offset-2 hover:underline">
              Catalog
            </Link>{" "}
            · {tables.map((t) => t.table_name).join(", ")}
          </p>
        </div>
        {!demo && <span className="relative">
          <KeyRound className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="passphrase"
            className="h-8 w-40 rounded-md border border-input bg-transparent pl-7 pr-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </span>}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto rounded-lg border bg-card p-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <Database className="h-10 w-10 text-muted-foreground" />
            <p className="max-w-sm text-sm text-muted-foreground">
              Ask a question about your data. The agent writes SQL, runs it
              read-only, and shows you exactly what it did.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {STARTERS.map((s) => (
                <Button key={s} variant="outline" size="sm" onClick={() => void ask(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} onRerun={m.sql ? () => void ask(m.sql ?? "") : null} />
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your data…"
          className="h-10 flex-1 rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" disabled={busy || !input.trim()}>
          <Send /> Ask
        </Button>
      </form>
    </div>
  );
}

function MessageBubble({ message, onRerun }: { message: Message; onRerun: (() => void) | null }) {
  if (message.role === "user") {
    return (
      <div className="ml-auto max-w-[75%] rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">
        {message.content}
      </div>
    );
  }
  return (
    <div className="max-w-[90%] space-y-2">
      <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        {message.content || "…"}
      </div>
      {message.sql && (
        <Card>
          <CardHeader className="pb-2 pt-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
                SQL (read-only)
              </CardTitle>
              <div className="flex gap-1">
                {message.guardReport?.every((g) => g.pass) && (
                  <Badge variant="success">guarded</Badge>
                )}
                {onRerun && (
                  <Button variant="ghost" size="sm" onClick={onRerun}>
                    Rerun
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(message.sql ?? "");
                    toast.success("SQL copied");
                  }}
                >
                  <ClipboardCopy /> Copy
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pb-3">
            <pre className="overflow-x-auto rounded bg-background p-2 font-mono text-xs">
              {message.sql}
            </pre>
          </CardContent>
        </Card>
      )}
      {message.columns && message.columns.length > 0 && (
        <ResultGrid
          columns={message.columns}
          rows={message.rows ?? []}
          truncated={message.truncated ?? false}
        />
      )}
    </div>
  );
}

function ResultGrid({
  columns,
  rows,
  truncated,
}: {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted text-muted-foreground">
          <tr>
            {columns.map((c) => (
              <th key={c} className="px-3 py-1.5 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.slice(0, 50).map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j} className="px-3 py-1.5 font-mono">
                  {v === null || v === undefined ? <span className="text-muted-foreground">null</span> : String(v as string)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(truncated || rows.length > 50) && (
        <div className="border-t px-3 py-1.5 text-xs text-muted-foreground">
          showing first {Math.min(50, rows.length)} of {rows.length}
          {truncated ? "+" : ""} rows
        </div>
      )}
    </div>
  );
}
