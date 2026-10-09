import postgres from "postgres";
import { requireEnvValue } from "./env";

let adminClient: postgres.Sql | null = null;

/**
 * Admin connection (transaction pooler — always prepare:false). Used by API
 * routes, server components, and the ingestion pipeline. RLS is on for all
 * public tables; this role bypasses it as the table owner.
 */
export function getAdminDb(): postgres.Sql {
  if (!adminClient) {
    adminClient = postgres(requireEnvValue("DATABASE_URL_ADMIN"), {
      prepare: false,
      max: 5,
    });
  }
  return adminClient;
}
