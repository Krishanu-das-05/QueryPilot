import type { NextRequest } from "next/server";
import { env } from "./env";

/** Temporary upload gate until Google auth lands (Weekend 2). */
export function checkPassphrase(req: NextRequest): boolean {
  const expected = env("UPLOAD_PASSPHRASE");
  if (!expected) return false;
  const given = req.headers.get("x-upload-passphrase");
  return given !== null && given === expected;
}
