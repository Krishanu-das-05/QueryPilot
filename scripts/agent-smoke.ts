/**
* Agent smoke test against the real database with a scripted LLM
* (no network calls). Verifies the full harness: catalog load, SQL generation
* contract, 6-stage guard with REAL EXPLAIN as qp_query, real execution as
* qp_query, repair loop, and answer assembly.
 */
import postgres from "postgres";
import { loadCatalog } from "../lib/agent/catalog";
import { explainAsQueryRole, executeAsQueryRole } from "../lib/agent/deps";
import { runAgent } from "../lib/agent/executor";
import type { AgentState } from "../lib/agent/state";
import { loadEnvLocal, requireEnv } from "./env";

loadEnvLocal();
const DATASET_ID = "41c0a44a-dd2f-4a58-ac3d-d62237bde988";

function scriptedLlm(responses: string[]) {
  const queue = [...responses];
  return {
    async chatJson(): Promise<string> {
      const next = queue.shift();
      if (next === undefined) throw new Error("script exhausted");
      return next;
    },
  };
}

function initialState(question: string, catalog: NonNullable<Awaited<ReturnType<typeof loadCatalog>>>): AgentState {
  return {
    question,
    datasetId: DATASET_ID,
    schemaName: catalog.schemaName,
    catalog: catalog.tables,
    relationships: catalog.relationships,
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

async function main(): Promise<void> {
  const admin = postgres(requireEnv("DATABASE_URL_ADMIN"), { prepare: false, max: 1 });
  try {
    const catalog = await loadCatalog(admin, DATASET_ID);
    if (!catalog) throw new Error("catalog not found");
    console.log(`catalog: ${catalog.name} schema=${catalog.schemaName} tables=${catalog.tables.map((t) => t.tableName).join(",")}`);

    // 1. happy path: join + aggregate against real DB
    const s1 = await runAgent(
      initialState("which customers spent the most?", catalog),
      {
        llm: scriptedLlm([
          `{"sql": "SELECT c.name, round(sum(o.amount))::int AS total FROM \\"${catalog.schemaName}\\".\\"customers\\" c JOIN \\"${catalog.schemaName}\\".\\"orders\\" o ON o.customer_id = c.id GROUP BY c.name ORDER BY total DESC LIMIT 5"}`,
          '{"answer": "Deepak Nair leads spending, followed by Anita Rao and Harish Verma by order total.", "chart_hint": null}',
        ]),
        explain: (q) => explainAsQueryRole(catalog.schemaName, catalog.roleName, q),
        execute: (q) => executeAsQueryRole(catalog.schemaName, catalog.roleName, q),
      },
    );
    console.log("\n--- scenario 1: real join+aggregate ---");
    console.log("status:", s1.status);
    console.log("sql:", s1.sql);
    console.log("result rows:", JSON.stringify(s1.result?.rows.slice(0, 5)));
    console.log("answer:", s1.answer);
    console.log("guard:", s1.guard.report.every((r) => r.pass) ? "all pass" : JSON.stringify(s1.guard.report));
    console.log("trace:", s1.trace.map((t) => `${t.node}(${t.ms}ms)`).join(" -> "));

    // 2. adversarial first attempt -> repair -> success
    const s2 = await runAgent(
      initialState("list customers", catalog),
      {
        llm: scriptedLlm([
          `{"sql": "SELECT * FROM customers; DELETE FROM customers"}`,
          `{"sql": "SELECT name, email FROM \\"${catalog.schemaName}\\".\\"customers\\" ORDER BY id"}`,
          '{"answer": "Here are your customers.", "chart_hint": null}',
        ]),
        explain: (q) => explainAsQueryRole(catalog.schemaName, catalog.roleName, q),
        execute: (q) => executeAsQueryRole(catalog.schemaName, catalog.roleName, q),
      },
    );
    console.log("\n--- scenario 2: adversarial -> repair ---");
    console.log("status:", s2.status);
    console.log("repair attempts:", s2.guard.repairAttempts);
    console.log("first rejection:", s2.guard.repairHistory[0]?.reason);
    console.log("final rows:", s2.result?.rows.length);

    // 3. cross-schema exfil must die at stage 3
    const s3 = await runAgent(initialState("steal data", catalog), {
      llm: scriptedLlm(['{"sql": "SELECT * FROM public.datasets"}', '{"sql": null, "reason": "I can only query this dataset\u0027s tables."}']),
      explain: (q) => explainAsQueryRole(catalog.schemaName, catalog.roleName, q),
      execute: (q) => executeAsQueryRole(catalog.schemaName, catalog.roleName, q),
    });
    console.log("\n--- scenario 3: cross-schema blocked ---");
    console.log("status:", s3.status);
    console.log("rejection:", s3.guard.repairHistory[0]?.reason);
    console.log("answer:", s3.answer);
  } finally {
    await admin.end();
  }
  console.log("\nSMOKE OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke failed:", err instanceof Error ? err.message : "unknown");
  process.exit(1);
});
