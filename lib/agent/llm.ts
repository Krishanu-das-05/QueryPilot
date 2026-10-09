import OpenAI from "openai";
import { z } from "zod";
import { env } from "../env";
import { extractJson } from "../ingest/describe";

export interface LlmClient {
  /** One JSON-shaped chat completion; returns raw text for the caller to parse. */
  chatJson(system: string, user: string): Promise<string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** OpenRouter chat client: primary model, 2 retries on 429/5xx w/ backoff,
 * then the fallback model once. Throws when unreachable. */
export function createOpenRouterLlm(): LlmClient {
  const apiKey = env("OPENROUTER_API_KEY");
  const primary = env("OPENROUTER_MODEL");
  const fallback = env("OPENROUTER_FALLBACK_MODEL");
  if (!apiKey || !primary) {
    throw new Error("OpenRouter is not configured");
  }
  const client = new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" });

  return {
    async chatJson(system: string, user: string): Promise<string> {
      const models = [primary, fallback ?? primary];
      let lastErr: unknown = null;
      for (const model of models) {
        for (let attempt = 0; attempt <= 2; attempt += 1) {
          try {
            const res = await client.chat.completions.create({
              model,
              max_tokens: 1500,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
            });
            return res.choices[0]?.message?.content ?? "";
          } catch (err) {
            lastErr = err;
            const retryable =
              err instanceof OpenAI.APIError &&
              (err.status === 429 || (err.status ?? 0) >= 500);
            if (retryable && attempt < 2) {
              await sleep(400 * 2 ** attempt);
              continue;
            }
            break; // next model
          }
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error("LLM call failed");
    },
  };
}

/** Parse + validate model JSON; on contract failure returns null. */
export function parseModelJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  const candidate = extractJson(raw);
  if (candidate === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(candidate));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
