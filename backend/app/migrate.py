import asyncio
import re
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import asyncpg

from .config import REPO_ROOT, Settings, settings_from_startup

MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MIGRATION_LOCK_KEY = 74195001
FILE_NAME_PATTERN = re.compile(r"^[0-9]{4}_[a-z0-9_]+\.sql$")
SUBSTITUTION_MARKER = ":QP_QUERY_PASSWORD"
DOLLAR_DELIMITER = "$$"
DOLLAR_TAG_BASE = "$qp_roles_block$"
LOCK_SQL = "SELECT pg_advisory_xact_lock($1::bigint)"
CREATE_LEDGER_SQL = (
    "CREATE TABLE IF NOT EXISTS public.schema_migrations "
    "(file_name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
)
LEDGER_SQL = "SELECT file_name FROM public.schema_migrations"
RECORD_SQL = "INSERT INTO public.schema_migrations (file_name) VALUES ($1)"
CONNECT_OPTIONS = {"statement_cache_size": 0, "command_timeout": 30}
FAILURE_MESSAGE = "Migration failed; check private configuration and database permissions."
MISSING_DSN_MESSAGE = "Missing required environment variable: DATABASE_URL_ADMIN"

Connector = Callable[..., Awaitable[Any]]


class MissingEnvironmentVariable(ValueError):
    def __init__(self, name: str) -> None:
        super().__init__(f"Missing required environment variable {name}")
        self.name = name


def _choose_dollar_tag(literal: str, body: str) -> str:
    tag = DOLLAR_TAG_BASE
    index = 0
    while tag in literal or tag in body:
        index += 1
        tag = f"$qp_roles_block_{index}$"
    return tag


def _template_spans(body: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    i = 0
    while i < len(body):
        if body.startswith("--", i):
            while i < len(body) and body[i] not in "\r\n":
                i += 1
        elif body.startswith("/*", i):
            depth = 1
            i += 2
            while i < len(body) and depth:
                if body.startswith("/*", i):
                    depth += 1
                    i += 2
                elif body.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            if depth:
                raise ValueError("invalid migration template")
        elif body[i] in "'\"":
            quote = body[i]
            escape = (
                quote == "'"
                and i > 0
                and body[i - 1] in "Ee"
                and (i < 2 or not (body[i - 2].isalnum() or body[i - 2] == "_"))
            )
            i += 1
            while i < len(body):
                if escape and body[i] == "\\":
                    i += 2
                elif body[i] == quote:
                    i += 1
                    if i < len(body) and body[i] == quote:
                        i += 1
                    else:
                        break
                else:
                    i += 1
            else:
                raise ValueError("invalid migration template")
        elif body.startswith(SUBSTITUTION_MARKER, i):
            end = i + len(SUBSTITUTION_MARKER)
            spans.append((i, end))
            i = end
        else:
            i += 1
    return spans


def render_migration(body: str, qp_query_password: str | None) -> str:
    if not _template_spans(body):
        return body
    if not qp_query_password:
        raise MissingEnvironmentVariable("QP_QUERY_PASSWORD")
    if "\x00" in qp_query_password:
        raise ValueError("invalid migration credential")
    escaped = qp_query_password.replace("\\", "\\\\").replace("'", "''")
    for character, replacement in (("\n", r"\n"), ("\r", r"\r"), ("\t", r"\t")):
        escaped = escaped.replace(character, replacement)
    literal = "E'" + escaped + "'"
    tag = _choose_dollar_tag(literal, body)
    template = body.replace(DOLLAR_DELIMITER, tag)
    spans = _template_spans(template)
    parts: list[str] = []
    start = 0
    for left, right in spans:
        parts.extend((template[start:left], literal))
        start = right
    parts.append(template[start:])
    return "".join(parts)


def migration_files(migrations_dir: Path) -> list[Path]:
    paths = sorted(migrations_dir.glob("*.sql"), key=lambda path: path.name)
    for path in paths:
        if not FILE_NAME_PATTERN.match(path.name):
            raise ValueError("unexpected migration file name")
    return paths


async def apply_migrations(
    conn: asyncpg.Connection,
    migrations_dir: Path,
    qp_query_password: str | None = None,
) -> list[str]:
    paths = migration_files(migrations_dir)
    applied_now: list[str] = []
    async with conn.transaction():
        await conn.execute(LOCK_SQL, MIGRATION_LOCK_KEY)
        await conn.execute(CREATE_LEDGER_SQL)
        rows = await conn.fetch(LEDGER_SQL)
        applied = {row["file_name"] for row in rows}
        for path in paths:
            if path.name in applied:
                continue
            body = path.read_text(encoding="utf-8")
            await conn.execute(render_migration(body, qp_query_password))
            await conn.execute(RECORD_SQL, path.name)
            applied_now.append(path.name)
    return applied_now


async def run_migrations(
    dsn: str,
    qp_query_password: str | None,
    *,
    migrations_dir: Path = MIGRATIONS_DIR,
    connect: Connector | None = None,
) -> list[str]:
    connector = asyncpg.connect if connect is None else connect
    conn = await connector(dsn=dsn, **CONNECT_OPTIONS)
    try:
        return await apply_migrations(conn, migrations_dir, qp_query_password)
    finally:
        await conn.close()


def main() -> int:
    try:
        settings: Settings = settings_from_startup()
    except Exception:
        print(FAILURE_MESSAGE, file=sys.stderr)
        return 1
    if not settings.database_url_admin:
        print(MISSING_DSN_MESSAGE, file=sys.stderr)
        return 1
    try:
        applied = asyncio.run(
            run_migrations(settings.database_url_admin, settings.qp_query_password)
        )
    except MissingEnvironmentVariable as exc:
        print(f"Missing required environment variable: {exc.name}", file=sys.stderr)
        return 1
    except Exception:
        print(FAILURE_MESSAGE, file=sys.stderr)
        return 1
    for name in applied:
        print(f"applied {name}")
    print(f"{len(applied)} migration(s) applied")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
