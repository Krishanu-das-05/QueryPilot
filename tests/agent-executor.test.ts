import { describe, expect, it } from "vitest";
import { runAgent } from "@/lib/agent/executor";
import type { AgentDeps } from "@/lib/agent/nodes";
import { repairCategory, type AgentState } from "@/lib/agent/state";

function catalogState(question: string): AgentState {
  return {
    question,
    datasetId: "00000000-0000-0000-0000-000000000001",
    schemaName: "ds_abcd1234",
    catalog: [
      {
        tableName: "customers",
        rowCount: 12,
        description: null,
        columns: [
          {
            tableName: "customers",
            columnName: "id",
            dataType: "integer",
            description: null,
            isCandidateKey: true,
            nullPct: 0,
            distinctCount: 12,
            minValue: "1",
            maxValue: "12",
            topValues: null,
            dateFormat: null,
            isPercent: false,
          },
        ],
      },
      {
        tableName: "orders",
        rowCount: 16,
        description: null,
        columns: [
          {
            tableName: "orders",
            columnName: "customer_id",
            dataType: "integer",
            description: null,
            isCandidateKey: false,
            nullPct: 0,
            distinctCount: 12,
            minValue: "1",
            maxValue: "12",
            topValues: null,
            dateFormat: null,
            isPercent: false,
          },
          {
            tableName: "orders",
            columnName: "amount",
            dataType: "integer",
            description: null,
            isCandidateKey: false,
            nullPct: 0,
            distinctCount: 16,
            minValue: "60",
            maxValue: "15500",
            topValues: null,
            dateFormat: null,
            isPercent: false,
          },
        ],
      },
    ],
    relationships: [
      { fromTable: "orders", fromColumn: "customer_id", toTable: "customers", toColumn: "id" },
    ],
    slice: null,
    answer: null,
    sql: null,
    result: null,
    guard: { sql: null, report: [], repairAttempts: 0, repairHistory: [] },
    trace: [],
    status: "working",
    error: null,
  };
}

function scriptLlm(responses: string[]) {
  const queue = [...responses];
  return {
    calls: 0,
    client: {
      async chatJson(): Promise<string> {
        queue.length += 0;
        const next = queue.shift();
        if (next === undefined) throw new Error("scripted LLM exhausted");
        return next;
      },
    },
    assertExhausted: () => expect(queue.length).toBe(0),
  };
}

function deps(
  llmResponses: string[],
  overrides: Partial<Omit<AgentDeps, "llm">> = {},
): AgentDeps & { assertLlm: () => void } {
  const script = scriptLlm(llmResponses);
  return {
    llm: { chatJson: () => script.client.chatJson() },
    explain: overrides.explain ?? (async () => ({ ok: true, planRows: 50 })),
    execute:
      overrides.execute ??
      (async () => ({
        columns: ["n"],
        rows: [[42]],
        truncated: false,
        elapsedMs: 12,
      })),
    assertLlm: script.assertExhausted,
  };
}

describe("repairCategory", () => {
  it("maps common reason shapes", () => {
    expect(repairCategory('column "xyz" does not exist')).toBe("unknown-identifier");
    expect(repairCategory("syntax error at or near")).toBe("syntax");
    expect(repairCategory("canceling statement due to statement timeout")).toBe("timeout");
    expect(repairCategory("not-read-only:delete")).toBe("guardrail");
    expect(repairCategory("off-limits:public.datasets")).toBe("unknown-identifier");
  });

  it("classifies explain-failed reasons by their specific cause", () => {
    expect(repairCategory("explain-failed:query timed out")).toBe("timeout");
    expect(repairCategory("explain-failed:type mismatch")).toBe("type-mismatch");
    expect(repairCategory("explain-failed:permission denied")).toBe("permission");
    expect(repairCategory("explain-failed:query failed")).toBe("syntax");
  });
});

describe("agent error sanitization", () => {
  it("never copies provider error text into state or trace", async () => {
    const secret = "FAKE-KEY-FOR-TESTING";
    const state = await runAgent(catalogState("anything"), {
      llm: { chatJson: async () => { throw new Error(`auth failed for ${secret}`); } },
      explain: async () => ({ ok: true, planRows: 1 }),
      execute: async () => ({ columns: [], rows: [], truncated: false, elapsedMs: 1 }),
    });
    expect(state.status).toBe("failed");
    expect(state.error).toBe("agent unavailable");
    expect(state.trace.find((t) => t.note)?.note).toBe("error: agent unavailable");
    expect(JSON.stringify(state)).not.toContain(secret);
  });

  it("maps database categories to repair categories", () => {
    expect(repairCategory("unknown identifier")).toBe("unknown-identifier");
    expect(repairCategory("query timed out")).toBe("timeout");
  });
});

describe("runAgent", () => {
  it("happy path: retrieve → generate → guard → execute → answer", async () => {
    const d = deps([
      '{"sql": "SELECT sum(amount) AS total FROM \\"ds_abcd1234\\".\\"orders\\""}',
      '{"answer": "Total spend is 42.", "chart_hint": null}',
    ]);
    const state = await runAgent(catalogState("total spend?"), { ...d, llm: d.llm });
    expect(state.status).toBe("answered");
    expect(state.result?.rows).toEqual([[42]]);
    expect(state.answer).toContain("42");
    expect(state.sql).toContain("LIMIT 1000");
    expect(d.assertLlm).not.toThrow();
    expect(state.trace.map((t) => t.node)).toEqual([
      "retrieve", "generate", "guard", "execute", "answer",
    ]);
  });

  it("repairs a guardrail failure once, then succeeds", async () => {
    const d = deps([
      '{"sql": "DELETE FROM \\"ds_abcd1234\\".\\"orders\\""}',
      '{"sql": "SELECT count(*) AS n FROM \\"ds_abcd1234\\".\\"orders\\""}',
      '{"answer": "42 orders on record.", "chart_hint": null}',
    ]);
    const state = await runAgent(catalogState("how many orders?"), d);
    expect(state.status).toBe("answered");
    expect(state.guard.repairAttempts).toBe(1);
    expect(state.result?.rows[0]?.[0]).toBe(42);
  });

  it("stops after 3 repair attempts and degrades", async () => {
    const d = deps(
      [
        '{"sql": "DELETE FROM x"}',
        '{"sql": "DROP TABLE y"}',
        '{"sql": "TRUNCATE z"}',
      ],
      { execute: async () => { throw new Error("boom"); } },
    );
    const state = await runAgent(catalogState("wreck it"), d);
    expect(state.guard.repairAttempts).toBe(3);
    expect(["rejected", "answered"]).toContain(state.status);
    expect(state.answer).toBeTruthy();
  });

  it("degrades when the LLM is unreachable", async () => {
    const state = await runAgent(catalogState("anything"), {
      llm: { chatJson: async () => { throw new Error("Connection error"); } },
      explain: async () => ({ ok: true, planRows: 1 }),
      execute: async () => ({ columns: [], rows: [], truncated: false, elapsedMs: 1 }),
    });
    expect(state.status).toBe("failed");
    expect(state.answer).toMatch(/unavailable/i);
  });

  it("answers with guidance when the model returns no SQL", async () => {
    const d = deps(['{"sql": null, "reason": "not enough info"}']);
    const state = await runAgent(catalogState("???"), d);
    expect(state.answer).toBe("not enough info");
    expect(state.status).toBe("answered");
  });
});
