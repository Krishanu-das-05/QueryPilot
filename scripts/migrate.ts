/**
 * npm run migrate — applies db/migrations/*.sql via DATABASE_URL_ADMIN.
 * See lib/migrate.ts for the implementation.
 */
import { applyMigrations } from "../lib/migrate";
import { loadEnvLocal, requireEnv } from "./env";

async function main(): Promise<void> {
  loadEnvLocal();
  await applyMigrations({
    url: requireEnv("DATABASE_URL_ADMIN"),
    qpQueryPassword: process.env.QP_QUERY_PASSWORD,
    log: (msg) => console.log(msg),
  });
  console.log("migrations complete");
}

main().catch((err) => {
  console.error("migration failed:", err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
