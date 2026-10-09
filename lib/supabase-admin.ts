import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnvValue } from "./env";

let client: SupabaseClient | null = null;

/** Service-role client — used ONLY for Storage (signed URLs, downloads). */
export function getSupabaseAdmin(): SupabaseClient {
  if (!client) {
    client = createClient(
      requireEnvValue("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnvValue("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } },
    );
  }
  return client;
}
