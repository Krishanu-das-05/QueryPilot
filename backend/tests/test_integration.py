import json
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from app.db import create_admin_pool, qualified, quote_ident, statement
from app.ingest.pipeline import PgIngestStore, run_ingest_step

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL, reason="TEST_DATABASE_URL not set; real-Postgres tests are opt-in"
)
FIXTURE_DIR = Path(__file__).resolve().parents[2] / "evals" / "messy-csv"
BOUND_TEST_ROWS = 25005
ROLLBACK_TEST_ROWS = 2505


def csv_ids(count: int) -> bytes:
    return ("id\n" + "\n".join(str(i) for i in range(1, count + 1)) + "\n").encode()


async def create_dataset(
    pool, dataset_id: UUID, files: list[tuple[str, str, bytes]]
) -> dict[str, bytes]:
    contents: dict[str, bytes] = {}
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO public.datasets (id, name, status) VALUES ($1, $2, 'uploaded')",
            dataset_id,
            "integration",
        )
        for original_name, table_name, content in files:
            path = f"{dataset_id}/{uuid4()}-{original_name}"
            await conn.execute(
                """
                INSERT INTO public.dataset_files
                    (dataset_id, storage_path, original_name, size_bytes, table_name)
                VALUES ($1, $2, $3, $4, $5)
                """,
                dataset_id,
                path,
                original_name,
                len(content),
                table_name,
            )
            contents[path] = content
    return contents


async def describe_nothing(data):
    return None


def content_getter(contents: dict[str, bytes]) -> Callable[..., Awaitable[bytes]]:
    async def get_content(file):
        return contents[file.storage_path]

    return get_content


async def step(pool, dataset_id: UUID, contents, after_batch=None) -> dict:
    return await run_ingest_step(
        dataset_id,
        pool,
        get_content=content_getter(contents),
        describe=describe_nothing,
        after_batch=after_batch,
    )


async def run_to_terminal(pool, dataset_id: UUID, contents, max_steps: int = 50) -> dict:
    for _ in range(max_steps):
        result = await step(pool, dataset_id, contents)
        if result["status"] in ("ready", "failed"):
            return result
    raise AssertionError("ingest did not reach a terminal status")


async def dataset_row(conn, dataset_id: UUID):
    return await conn.fetchrow(
        "SELECT status, schema_name, role_name FROM public.datasets WHERE id = $1", dataset_id
    )


async def file_cursor(conn, dataset_id: UUID) -> int:
    return await conn.fetchval(
        "SELECT rows_loaded FROM public.dataset_files WHERE dataset_id = $1", dataset_id
    )


async def count_rows(conn, schema: str, table: str, distinct_column: str | None = None) -> int:
    target = qualified(schema, table)
    if distinct_column is None:
        sql = statement("SELECT count(*) FROM", target)
    else:
        sql = statement("SELECT count(DISTINCT", quote_ident(distinct_column), ") FROM", target)
    return await conn.fetchval(sql)


async def cleanup(pool, dataset_id: UUID) -> None:
    async with pool.acquire() as conn:
        row = await dataset_row(conn, dataset_id)
        await conn.execute("DELETE FROM public.datasets WHERE id = $1", dataset_id)
        if row is not None and row["schema_name"]:
            await conn.execute(
                statement("DROP SCHEMA IF EXISTS", quote_ident(row["schema_name"]), "CASCADE")
            )
        if row is not None and row["role_name"]:
            await conn.execute(statement("DROP ROLE IF EXISTS", quote_ident(row["role_name"])))


async def test_real_loading_is_bounded_per_step_and_resumes_to_completion():
    pool = await create_admin_pool(TEST_DATABASE_URL)
    dataset_id = uuid4()
    try:
        contents = await create_dataset(
            pool, dataset_id, [("data.csv", "data", csv_ids(BOUND_TEST_ROWS))]
        )
        await step(pool, dataset_id, contents)
        await step(pool, dataset_id, contents)
        assert await step(pool, dataset_id, contents) == {"status": "loading", "progress": 80}
        async with pool.acquire() as conn:
            schema = (await dataset_row(conn, dataset_id))["schema_name"]
            assert await file_cursor(conn, dataset_id) == 20000
            assert await count_rows(conn, schema, "data") == 20000

        assert await step(pool, dataset_id, contents) == {"status": "loading", "progress": 100}
        async with pool.acquire() as conn:
            assert await file_cursor(conn, dataset_id) == BOUND_TEST_ROWS
            assert await count_rows(conn, schema, "data") == BOUND_TEST_ROWS
            assert await count_rows(conn, schema, "data", "id") == BOUND_TEST_ROWS

        assert await run_to_terminal(pool, dataset_id, contents) == {
            "status": "ready",
            "progress": 100,
        }
        async with pool.acquire() as conn:
            assert await count_rows(conn, schema, "data") == BOUND_TEST_ROWS
    finally:
        await cleanup(pool, dataset_id)
        await pool.close()


async def test_real_injected_failure_rolls_back_rows_and_cursor_then_retries_to_completion():
    pool = await create_admin_pool(TEST_DATABASE_URL)
    dataset_id = uuid4()
    try:
        contents = await create_dataset(
            pool, dataset_id, [("data.csv", "data", csv_ids(ROLLBACK_TEST_ROWS))]
        )
        await step(pool, dataset_id, contents)
        await step(pool, dataset_id, contents)

        async with pool.acquire() as conn, conn.transaction():
            row = await dataset_row(conn, dataset_id)
            store = PgIngestStore(conn)
            await store.ensure_loading_infra(
                row["schema_name"],
                row["role_name"],
                await store.catalog_columns_by_table(dataset_id),
            )
        schema = row["schema_name"]

        async def fail_after_first_batch(batch_index: int) -> None:
            if batch_index == 0:
                raise RuntimeError("injected failure after first batch")

        with pytest.raises(RuntimeError, match="injected failure"):
            await step(pool, dataset_id, contents, after_batch=fail_after_first_batch)

        async with pool.acquire() as conn:
            assert await count_rows(conn, schema, "data") == 0
            assert await file_cursor(conn, dataset_id) == 0
            assert (await dataset_row(conn, dataset_id))["status"] == "loading"

        assert await run_to_terminal(pool, dataset_id, contents) == {
            "status": "ready",
            "progress": 100,
        }
        async with pool.acquire() as conn:
            assert await count_rows(conn, schema, "data") == ROLLBACK_TEST_ROWS
            assert await count_rows(conn, schema, "data", "id") == ROLLBACK_TEST_ROWS
            assert await file_cursor(conn, dataset_id) == ROLLBACK_TEST_ROWS
    finally:
        await cleanup(pool, dataset_id)
        await pool.close()


async def test_real_messy_fixtures_produce_expected_counts_types_and_foreign_key():
    pool = await create_admin_pool(TEST_DATABASE_URL)
    dataset_id = uuid4()
    expected_types = json.loads((FIXTURE_DIR / "expected.json").read_text(encoding="utf-8"))
    try:
        contents = await create_dataset(
            pool,
            dataset_id,
            [
                ("09-customers.csv", "customers", (FIXTURE_DIR / "09-customers.csv").read_bytes()),
                ("10-orders.csv", "orders", (FIXTURE_DIR / "10-orders.csv").read_bytes()),
            ],
        )
        assert await run_to_terminal(pool, dataset_id, contents) == {
            "status": "ready",
            "progress": 100,
        }
        async with pool.acquire() as conn:
            schema = (await dataset_row(conn, dataset_id))["schema_name"]
            assert await count_rows(conn, schema, "customers") == 12
            assert await count_rows(conn, schema, "orders") == 16

            relationships = await conn.fetch(
                """
                SELECT from_table, from_column, to_table, to_column, overlap
                FROM public.catalog_relationships WHERE dataset_id = $1
                """,
                dataset_id,
            )
            assert [tuple(r) for r in relationships] == [
                ("orders", "customer_id", "customers", "id", 1.0)
            ]

            columns = await conn.fetch(
                """
                SELECT t.table_name, c.column_name, c.data_type
                FROM public.catalog_columns c
                JOIN public.catalog_tables t ON t.id = c.table_id
                WHERE t.dataset_id = $1
                """,
                dataset_id,
            )
        actual = {(r["table_name"], r["column_name"]): r["data_type"] for r in columns}
        for fixture_name, table in (("09-customers.csv", "customers"), ("10-orders.csv", "orders")):
            for column in expected_types[fixture_name]:
                assert actual[(table, column["name"])] == column["type"]
    finally:
        await cleanup(pool, dataset_id)
        await pool.close()
