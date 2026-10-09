/** Server-only env accessors. Values are read lazily so `next build` works
 * without real secrets. Never log these values. */

export function env(name: string): string | undefined {
  return process.env[name] || undefined;
}

export function requireEnvValue(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const UPLOAD_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024, // 10 MB
  maxFilesPerDataset: 5,
  allowedExtensions: [".csv", ".xlsx"] as const,
};
