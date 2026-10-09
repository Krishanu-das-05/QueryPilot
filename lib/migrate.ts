import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

/**
 * Applies db/migrations/*.sql in file-name order against the given connection,
 * recording applied files in public.schema_migrations. Idempotent.
 * :QP_QUERY_PASSWORD placeholders are substituted from `qpQueryPassword`.
 * Passwords are never logged.
 */
export async function applyMigrations(options: {
  url: string;
  qpQueryPassword?: string;
  log?: (msg: string) => void;
}): Promise<void> {
  const log = options.log ?? (() => {});
  const sql = postgres(options.url, { prepare: false, max: 1 });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        file_name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    const appliedRows = await sql<{ file_name: string }[]>`
      SELECT file_name FROM public.schema_migrations
    `;
    const applied = new Set(appliedRows.map((r) => r.file_name));

    const dir = resolve(process.cwd(), "db", "migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        log(`skip      ${file} (already applied)`);
        continue;
      }
      let body = readFileSync(resolve(dir, file), "utf8");
      if (body.includes(":QP_QUERY_PASSWORD")) {
        if (!options.qpQueryPassword) {
          throw new Error(
            `${file} needs QP_QUERY_PASSWORD set (password for the qp_query role).`,
          );
        }
        const escaped = options.qpQueryPassword.replaceAll("'", "''");
        body = body.replaceAll(":QP_QUERY_PASSWORD", `'${escaped}'`);
      }
      await sql.unsafe(body);
      await sql`
        INSERT INTO public.schema_migrations (file_name) VALUES (${file})
      `;
      log(`applied   ${file}`);
    }
  } finally {
    await sql.end();
  }
}
