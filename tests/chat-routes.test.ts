import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as chatPost } from "@/app/api/datasets/[id]/chat/route";
import { GET as datasetConversations } from "@/app/api/datasets/[id]/conversations/route";
import { GET as conversationDetail } from "@/app/api/conversations/[id]/route";
import { loadCatalog } from "@/lib/agent/catalog";
import { runAgent } from "@/lib/agent/executor";

const h = vi.hoisted(() => {
  const noRows = (): unknown[] => [];
  const state: {
    calls: { text: string; values: unknown[] }[];
    respond: (text: string, values: unknown[]) => unknown[];
  } = { calls: [], respond: noRows };
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      state.calls.push({ text, values });
      return Promise.resolve(state.respond(text, values));
    },
    { json: (value: unknown) => value },
  );
  return { state, sql };
});

vi.mock("@/lib/db", () => ({ getAdminDb: () => h.sql }));
vi.mock("@/lib/agent/catalog", () => ({ loadCatalog: vi.fn() }));
vi.mock("@/lib/agent/executor", () => ({ runAgent: vi.fn() }));
vi.mock("@/lib/agent/llm", () => ({ createOpenRouterLlm: vi.fn(() => ({ chatJson: vi.fn() })) }));
vi.mock("@/lib/agent/deps", () => ({
  explainAsQueryRole: vi.fn(),
  executeAsQueryRole: vi.fn(),
}));

const PASS = "FAKE-KEY-FOR-TESTING";
const DATASET = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const UNKNOWN = "99999999-9999-4999-8999-999999999999";
const CONV_A = "33333333-3333-4333-8333-333333333333";
const CONV_B = "44444444-4444-4444-8444-444444444444";
const NEW_CONV = "55555555-5555-4555-8555-555555555555";
const UNKNOWN_CONV = "66666666-6666-4666-8666-666666666666";
const CONVERSATIONS: Record<string, string> = { [CONV_A]: DATASET, [CONV_B]: OTHER };
const DATASETS = [DATASET, OTHER];
const withPass = { "x-upload-passphrase": PASS };

const CATALOG = {
  schemaName: "ds_11111111",
  roleName: "ds_11111111_r",
  name: "sales",
  tables: [],
  relationships: [],
};
const FINAL = {
  answer: "ok",
  status: "answered",
  trace: [],
  guard: { sql: null, report: [], repairAttempts: 0, repairHistory: [] },
  result: null,
  error: null,
};

function respond(text: string, values: unknown[]): unknown[] {
  if (text.includes("FROM datasets WHERE id")) {
    return DATASETS.includes(values[0] as string) ? [{ status: "ready" }] : [];
  }
  if (text.includes("count(*)::text")) return [{ n: "0" }];
  if (text.includes("FROM conversations c JOIN datasets")) {
    return CONVERSATIONS[values[0] as string] !== undefined ? [{ id: values[0] }] : [];
  }
  if (text.includes("SELECT id FROM conversations WHERE id")) {
    return CONVERSATIONS[values[0] as string] === values[1] ? [{ id: values[0] }] : [];
  }
  if (text.includes("INSERT INTO conversations")) return [{ id: NEW_CONV }];
  if (text.includes("WHERE dataset_id")) return [];
  if (text.includes("FROM messages") || text.includes("FROM queries")) return [];
  if (text.includes("INSERT INTO messages") || text.includes("INSERT INTO queries")) return [];
  throw new Error(`unscripted query: ${text}`);
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, { headers });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function statements(): string[] {
  return h.state.calls.map((c) => c.text);
}

beforeEach(() => {
  vi.stubEnv("UPLOAD_PASSPHRASE", PASS);
  h.state.calls = [];
  h.state.respond = respond;
  vi.mocked(loadCatalog).mockResolvedValue(CATALOG as never);
  vi.mocked(runAgent).mockResolvedValue(FINAL as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("chat route: passphrase and identifiers", () => {
  it("rejects a missing or wrong passphrase before touching the database", async () => {
    const missing = await chatPost(
      post(`/api/datasets/${DATASET}/chat`, { message: "hi" }),
      params(DATASET),
    );
    const wrong = await chatPost(
      post(`/api/datasets/${DATASET}/chat`, { message: "hi" }, { "x-upload-passphrase": "nope" }),
      params(DATASET),
    );
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(h.state.calls).toHaveLength(0);
  });

  it("rejects an invalid dataset UUID with 400 before any query", async () => {
    const res = await chatPost(
      post("/api/datasets/not-a-uuid/chat", { message: "hi" }, withPass),
      params("not-a-uuid"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid request" });
    expect(h.state.calls).toHaveLength(0);
  });

  it("returns 404 for an unknown dataset", async () => {
    const res = await chatPost(
      post(`/api/datasets/${UNKNOWN}/chat`, { message: "hi" }, withPass),
      params(UNKNOWN),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("refuses a conversation that belongs to another dataset before quota, writes, or agent", async () => {
    const res = await chatPost(
      post(`/api/datasets/${DATASET}/chat`, { message: "hi", conversationId: CONV_B }, withPass),
      params(DATASET),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(statements().some((s) => s.includes("count(*)::text"))).toBe(false);
    expect(statements().some((s) => s.includes("INSERT INTO messages"))).toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("keeps the owned conversation id and scopes the lookup to the bound dataset", async () => {
    const res = await chatPost(
      post(`/api/datasets/${DATASET}/chat`, { message: "hi", conversationId: CONV_A }, withPass),
      params(DATASET),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`event: conversation\ndata: {"id":"${CONV_A}"}`);
    const scoped = h.state.calls.find((c) => c.text.includes("SELECT id FROM conversations"));
    expect(scoped?.values).toEqual([CONV_A, DATASET]);
    const userInsert = h.state.calls.find((c) => c.text.includes("INSERT INTO messages"));
    expect(userInsert?.values).toContain(CONV_A);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("creates a new conversation when no id is supplied", async () => {
    const res = await chatPost(
      post(`/api/datasets/${DATASET}/chat`, { message: "hello" }, withPass),
      params(DATASET),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(NEW_CONV);
    expect(statements().some((s) => s.includes("INSERT INTO conversations"))).toBe(true);
  });

  it("sends a generic SSE error and never the raw agent failure text", async () => {
    const leaked = "FAKE-KEY-FOR-TESTING upstream detail";
    vi.mocked(runAgent).mockRejectedValue(new Error(leaked));
    const res = await chatPost(
      post(`/api/datasets/${DATASET}/chat`, { message: "hi" }, withPass),
      params(DATASET),
    );
    const body = await res.text();
    expect(body).toContain("event: error");
    expect(body).toContain('"category":"internal"');
    expect(body).toContain("Something went wrong. Please try again.");
    expect(body).not.toContain("FAKE-KEY-FOR-TESTING");
  });
});

describe("transcript read routes are protected and scoped", () => {
  it("dataset conversations: unauthorized makes zero database calls", async () => {
    const res = await datasetConversations(get(`/api/datasets/${DATASET}/conversations`), params(DATASET));
    expect(res.status).toBe(401);
    expect(h.state.calls).toHaveLength(0);
  });

  it("dataset conversations: invalid UUID is 400 with no query", async () => {
    const res = await datasetConversations(
      get("/api/datasets/bad/conversations", withPass),
      params("bad"),
    );
    expect(res.status).toBe(400);
    expect(h.state.calls).toHaveLength(0);
  });

  it("dataset conversations: unknown dataset is 404, not an empty list", async () => {
    const res = await datasetConversations(
      get(`/api/datasets/${UNKNOWN}/conversations`, withPass),
      params(UNKNOWN),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("conversation detail: unauthorized makes zero database calls", async () => {
    const res = await conversationDetail(get(`/api/conversations/${CONV_A}`), params(CONV_A));
    expect(res.status).toBe(401);
    expect(h.state.calls).toHaveLength(0);
  });

  it("conversation detail: invalid UUID is 400 with no query", async () => {
    const res = await conversationDetail(get("/api/conversations/nope", withPass), params("nope"));
    expect(res.status).toBe(400);
    expect(h.state.calls).toHaveLength(0);
  });

  it("conversation detail: unknown conversation is 404, not an empty transcript", async () => {
    const res = await conversationDetail(
      get(`/api/conversations/${UNKNOWN_CONV}`, withPass),
      params(UNKNOWN_CONV),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("conversation detail: existing conversation returns its messages and queries", async () => {
    const res = await conversationDetail(
      get(`/api/conversations/${CONV_A}`, withPass),
      params(CONV_A),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [], queries: [] });
    expect(statements().some((s) => s.includes("FROM conversations c JOIN datasets"))).toBe(true);
  });
});
