/**
 * Creates the PRIVATE storage bucket `uploads` via the service-role key.
 * Idempotent: a 409/already-exists response is treated as success.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnvLocal, requireEnv } from "./env";

async function main(): Promise<void> {
  loadEnvLocal();
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  const { error } = await supabase.storage.createBucket("uploads", {
    public: false,
    fileSizeLimit: "10MB",
    allowedMimeTypes: [
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  });
  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      console.log("bucket 'uploads' already exists — nothing to do");
      return;
    }
    throw new Error(`createBucket failed: ${error.message}`);
  }
  console.log("bucket 'uploads' created (private)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
