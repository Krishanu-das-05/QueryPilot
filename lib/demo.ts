import { env } from "./env";

export const DEMO_DATASET_IDS = [
  "4f60c5e4-8c11-4e43-9e12-325011b2b845",
  "7d5a8f16-42b0-4cf4-9667-0cfa5c7aa034",
] as const;

const APPROVED_IDS = new Set<string>(DEMO_DATASET_IDS);

export const DEMO_WRITE_ERROR = "Uploads and dataset changes are disabled for this demo.";

export function isDemoDeployment(): boolean {
  return env("VERCEL_ENV") === "production" || env("PUBLIC_DEMO_MODE") === "true";
}

export function isVisibleDataset(dataset: { id?: unknown; is_demo?: unknown }): boolean {
  return !isDemoDeployment() ||
    (dataset.is_demo === true && typeof dataset.id === "string" && APPROVED_IDS.has(dataset.id));
}

export function demoDailyCap(): number {
  const configured = process.env.DEMO_DAILY_CAP;
  const cap = configured === undefined ? 100 : Number(configured);
  if ((configured !== undefined && !configured.trim()) || !Number.isSafeInteger(cap) || cap <= 0) {
    throw new Error("DEMO_DAILY_CAP must be a positive integer");
  }
  return cap;
}
