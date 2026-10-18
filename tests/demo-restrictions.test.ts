import { NextRequest } from "next/server";
import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createDataset, GET as listDatasets } from "@/app/api/datasets/route";
import { POST as uploadUrl } from "@/app/api/datasets/[id]/upload-url/route";
import { POST as registerFile } from "@/app/api/datasets/[id]/files/route";
import { POST as ingestNext } from "@/app/api/datasets/[id]/ingest/next/route";
import { PATCH as editDescription } from "@/app/api/datasets/[id]/route";
import { getDatasetCatalog } from "@/lib/catalog";
import { DEMO_DATASET_IDS, isDemoDeployment, isVisibleDataset } from "@/lib/demo";
import { reserveDemoQuestion } from "@/lib/demo-question";
import { getAdminDb } from "@/lib/db";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { POST as chat } from "@/app/api/datasets/[id]/chat/route";
import { loadCatalog } from "@/lib/agent/catalog";
import { runAgent } from "@/lib/agent/executor";

const h = vi.hoisted(() => {
  const state: {
    calls: { text: string; values: unknown[] }[];
    respond: (text: string) => unknown[];
  } = { calls: [], respond: () => [] };
  return state;
});

vi.mock("@/lib/db", () => ({ getAdminDb: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/agent/catalog", () => ({ loadCatalog: vi.fn() }));
vi.mock("@/lib/agent/executor", () => ({ runAgent: vi.fn() }));

function fakeDb() {
  const sql = Object.assign(
    (strings: TemplateStringsArray | string[], ...values: unknown[]) => {
      if (!("raw" in strings)) return { values: strings };
      const text = strings.join("?");
      h.calls.push({ text, values });
      return Promise.resolve(h.respond(text));
    },
    {
      begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sql),
      json: (value: unknown) => value,
    },
  );
  return sql as unknown as postgres.Sql;
}

const OTHER = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("PUBLIC_DEMO_MODE", "false");
  vi.stubEnv("UPLOAD_PASSPHRASE", "FAKE-KEY-FOR-TESTING");
  vi.stubEnv("DEMO_DAILY_CAP", "100");
  h.calls = [];
  h.respond = () => [];
  vi.mocked(getAdminDb).mockReturnValue(fakeDb());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("production restrictions", () => {
  it("cannot turn off demo-only production restrictions with a false flag", () => {
    expect(isDemoDeployment()).toBe(true);
    expect(isVisibleDataset({ id: DEMO_DATASET_IDS[0], is_demo: true })).toBe(true);
    expect(isVisibleDataset({ id: DEMO_DATASET_IDS[0], is_demo: false })).toBe(false);
    expect(isVisibleDataset({ id: OTHER, is_demo: true })).toBe(false);
  });

  it.each([
    ["create", (req: NextRequest) => createDataset(req)],
    ["upload-url", (req: NextRequest) => uploadUrl(req, { params: Promise.resolve({ id: OTHER }) })],
    ["register", (req: NextRequest) => registerFile(req, { params: Promise.resolve({ id: OTHER }) })],
    ["ingest", (req: NextRequest) => ingestNext(req, { params: Promise.resolve({ id: OTHER }) })],
    ["patch", (req: NextRequest) => editDescription(req, { params: Promise.resolve({ id: OTHER }) })],
  ] as const)("refuses %s even with the correct passphrase, before database/storage", async (_name, run) => {
    const response = await run(new NextRequest("http://localhost/api/datasets", {
      method: "POST",
      headers: { "x-upload-passphrase": "FAKE-KEY-FOR-TESTING", "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Uploads and dataset changes are disabled for this demo." });
    expect(getAdminDb).not.toHaveBeenCalled();
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it("lists only approved demo IDs flagged as demo", async () => {
    h.respond = () => [
      { id: DEMO_DATASET_IDS[0], is_demo: true },
      { id: DEMO_DATASET_IDS[1], is_demo: false },
      { id: OTHER, is_demo: true },
    ];
    expect(await (await listDatasets()).json()).toEqual([
      { id: DEMO_DATASET_IDS[0], is_demo: true },
    ]);
  });

  it("does not read a non-demo catalog's files or sample values", async () => {
    h.respond = () => [{ id: OTHER, is_demo: false }];
    expect(await getDatasetCatalog(OTHER, fakeDb())).toBeNull();
    expect(h.calls).toHaveLength(1);
  });
});

describe("global demo question cap", () => {
  function script(count: number) {
    h.respond = (text) => {
      if (text.includes("FOR UPDATE")) {
        return DEMO_DATASET_IDS.map((id) => ({ id, is_demo: true, status: "ready" }));
      }
      if (text.includes("count(*)")) return [{ n: String(count) }];
      if (text.includes("SELECT id FROM conversations")) return [];
      if (text.includes("INSERT INTO conversations")) return [{ id: OTHER }];
      if (text.includes("INSERT INTO messages")) return [];
      throw new Error("Unexpected reservation query");
    };
  }

  it("rejects another demo dataset once the shared cap is reached", async () => {
    script(100);
    expect(await reserveDemoQuestion(fakeDb(), DEMO_DATASET_IDS[1], "count rows")).toMatchObject({
      ok: false, status: 429,
    });
    const lock = h.calls.findIndex((call) => call.text.includes("FOR UPDATE"));
    const count = h.calls.findIndex((call) => call.text.includes("count(*)"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(count).toBeGreaterThan(lock);
    expect(h.calls[count]?.text).toContain("interval '24 hours'");
    expect(h.calls.some((call) => call.text.includes("INSERT"))).toBe(false);
  });

  it("reserves the user question in the same transaction as the cap check", async () => {
    script(99);
    expect(await reserveDemoQuestion(fakeDb(), DEMO_DATASET_IDS[0], "count rows")).toEqual({
      ok: true, conversationId: OTHER,
    });
    expect(h.calls.at(-1)?.text).toContain("INSERT INTO messages");
  });

  it.each(["0", "-1", "NaN", "1.5", ""])("fails closed for invalid cap %s", async (value) => {
    vi.stubEnv("DEMO_DAILY_CAP", value);
    script(0);
    expect(await reserveDemoQuestion(fakeDb(), DEMO_DATASET_IDS[0], "count rows")).toMatchObject({
      ok: false, status: 503,
    });
    expect(h.calls).toHaveLength(0);
  });

  it("does not attach a demo question to an unknown or foreign conversation", async () => {
    script(0);
    expect(await reserveDemoQuestion(fakeDb(), DEMO_DATASET_IDS[0], "count rows", OTHER)).toMatchObject({
      ok: false, status: 404,
    });
    expect(h.calls.some((call) => call.text.includes("INSERT"))).toBe(false);
  });

  it("enforces the cap at the actual public chat endpoint before model execution", async () => {
    script(100);
    const reserveResponse = h.respond;
    h.respond = (text) => text.includes("FROM datasets WHERE id")
      ? [{ id: DEMO_DATASET_IDS[0], status: "ready", is_demo: true }]
      : reserveResponse(text);
    vi.mocked(loadCatalog).mockResolvedValue({
      schemaName: "ds_4f60c5e4", roleName: "ds_4f60c5e4_r",
      name: "synthetic fixture", tables: [], relationships: [],
    });
    const response = await chat(new NextRequest("http://localhost/api/datasets/demo/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Count the synthetic rows" }),
    }), { params: Promise.resolve({ id: DEMO_DATASET_IDS[0] }) });
    expect(response.status).toBe(429);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("refuses non-approved dataset IDs at the public chat endpoint", async () => {
    h.respond = () => [{ id: OTHER, status: "ready", is_demo: true }];
    const response = await chat(new NextRequest("http://localhost/api/datasets/demo/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Count rows" }),
    }), { params: Promise.resolve({ id: OTHER }) });
    expect(response.status).toBe(404);
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });
});
