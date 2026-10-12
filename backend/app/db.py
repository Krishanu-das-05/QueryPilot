import json

import asyncpg
from fastapi import HTTPException, Request

POOL_MIN_SIZE = 0
POOL_MAX_SIZE = 5
COMMAND_TIMEOUT_SECONDS = 30


def quote_ident(name: str) -> str:
    if not name or "\x00" in name:
        raise ValueError("invalid identifier")
    return '"' + name.replace('"', '""') + '"'


def qualified(schema: str, table: str) -> str:
    return f"{quote_ident(schema)}.{quote_ident(table)}"


def statement(*clauses: str) -> str:
    return " ".join(clauses)


async def _init_connection(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def create_admin_pool(dsn: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(
        dsn=dsn,
        min_size=POOL_MIN_SIZE,
        max_size=POOL_MAX_SIZE,
        command_timeout=COMMAND_TIMEOUT_SECONDS,
        statement_cache_size=0,
        init=_init_connection,
    )


def get_pool(request: Request) -> asyncpg.Pool:
    pool = getattr(request.app.state, "pool", None)
    if pool is None:
        raise HTTPException(status_code=503, detail="service unavailable")
    return pool
