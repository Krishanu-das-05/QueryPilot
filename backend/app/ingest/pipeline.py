import asyncio
import csv
import hashlib
import re
import zipfile
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from typing import Any
from uuid import UUID
from xml.etree.ElementTree import ParseError

import asyncpg
from openpyxl.utils.exceptions import InvalidFileException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from ..config import MAX_UPLOAD_BYTES
from ..db import quote_ident, statement
from .describe import DescribeFn, DescribeInput
from .headers import sanitize_headers
from .parse import parse_tabular_file
from .profile import ColumnProfile, TableProfile, profile_table
from .relationships import DetectedRelationship, detect_relationships
from .types import ColumnType, coerce_value

ROWS_PER_STEP = 20000
INSERT_BATCH = 1000
SAMPLE_ROW_LIMIT = 5
QP_QUERY_ROLE = "qp_query"
PROCESSING_FAILED_MESSAGE = "could not process uploaded data"
PG_TYPES = {
    "boolean": "boolean",
    "integer": "bigint",
    "decimal": "numeric",
    "date": "date",
    "timestamp": "timestamp",
    "text": "text",
}
_SAFE_IDENTIFIER = re.compile(r"[a-z][a-z0-9_]{0,62}")

GetContent = Callable[["FileRow"], Awaitable[bytes]]
AfterBatch = Callable[[int], Awaitable[None]]


class IngestBusy(Exception):
    pass


class DatasetNotFound(LookupError):
    pass


class IngestDataError(ValueError):
    pass


@dataclass(frozen=True)
class DatasetRow:
    id: UUID
    status: str
    schema_name: str | None
    role_name: str | None


@dataclass(frozen=True)
class FileRow:
    id: UUID
    storage_path: str
    original_name: str
    table_name: str
    row_count: int | None
    rows_loaded: int
    profile: dict[str, Any] | None


@dataclass(frozen=True)
class CatalogTableRow:
    id: UUID
    table_name: str
    description: str | None


def derived_names(dataset_id: UUID) -> tuple[str, str]:
    schema = f"ds_{dataset_id.hex[:8]}"
    return schema, f"{schema}_r"


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def serialize_profile(profile: TableProfile) -> dict[str, Any]:
    return {
        "rowCount": profile.row_count,
        "columns": [{_camel(k): v for k, v in asdict(c).items()} for c in profile.columns],
    }


class _StoredTopValue(BaseModel):
    model_config = ConfigDict(strict=True)

    value: str
    count: int = Field(ge=0)


class _StoredColumn(BaseModel):
    model_config = ConfigDict(strict=True, alias_generator=to_camel, populate_by_name=True)

    ordinal: int = Field(ge=0)
    column_name: str = Field(pattern=r"^[a-z][a-z0-9_]{0,62}$")
    original_header: str
    data_type: ColumnType
    date_format: str | None
    is_percent: bool
    is_candidate_key: bool
    row_count: int = Field(ge=0)
    null_count: int = Field(ge=0)
    null_pct: float = Field(ge=0, le=100, strict=False)
    distinct_count: int = Field(ge=0)
    coerced_count: int = Field(ge=0)
    min_value: str | None
    max_value: str | None
    top_values: list[_StoredTopValue]
    sample_values: list[str]
    distinct_values: list[str] | None


class _StoredProfile(BaseModel):
    model_config = ConfigDict(strict=True, alias_generator=to_camel, populate_by_name=True)

    row_count: int = Field(ge=0)
    columns: list[_StoredColumn]

    @model_validator(mode="after")
    def _unique_columns(self) -> "_StoredProfile":
        ordinals = {c.ordinal for c in self.columns}
        names = {c.column_name for c in self.columns}
        if len(ordinals) != len(self.columns) or len(names) != len(self.columns):
            raise ValueError("duplicate stored column")
        return self


def deserialize_profile(raw: Any) -> TableProfile:
    try:
        stored = _StoredProfile.model_validate(raw)
    except ValueError:
        raise IngestDataError(PROCESSING_FAILED_MESSAGE) from None
    columns = [ColumnProfile(**column.model_dump()) for column in stored.columns]
    return TableProfile(columns=columns, row_count=stored.row_count)


PARSE_ERRORS = (
    csv.Error,
    UnicodeError,
    zipfile.BadZipFile,
    InvalidFileException,
    ParseError,
    KeyError,
    OSError,
    ValueError,
)


def _parse_upload(
    original_name: str, content: bytes
) -> tuple[list[dict[str, str]], list[list[str]]]:
    try:
        parsed = parse_tabular_file(original_name, content)
    except PARSE_ERRORS:
        raise IngestDataError(PROCESSING_FAILED_MESSAGE) from None
    if not parsed.headers:
        raise IngestDataError(PROCESSING_FAILED_MESSAGE)
    return sanitize_headers(parsed.headers), parsed.rows


def _profile_upload(original_name: str, content: bytes) -> TableProfile:
    headers, rows = _parse_upload(original_name, content)
    return profile_table(headers, rows)


def _coerce_rows(
    rows: list[list[str]], columns: list[ColumnProfile]
) -> list[tuple[str | None, ...]]:
    out: list[tuple[str | None, ...]] = []
    for row in rows:
        values = []
        for index, spec in enumerate(columns):
            raw = row[index] if index < len(row) else ""
            values.append(coerce_value(raw, spec.data_type, spec.date_format).value)
        out.append(tuple(values))
    return out


def _pg_type(data_type: str) -> str:
    pg_type = PG_TYPES.get(data_type)
    if pg_type is None:
        raise IngestDataError(PROCESSING_FAILED_MESSAGE)
    return pg_type


def _check_identifiers(table_name: str, column_names: list[str]) -> None:
    for name in (table_name, *column_names):
        if not _SAFE_IDENTIFIER.fullmatch(name):
            raise IngestDataError(PROCESSING_FAILED_MESSAGE)


def _stored_names(ds: DatasetRow) -> tuple[str, str]:
    schema, role = derived_names(ds.id)
    if ds.schema_name != schema or ds.role_name != role:
        raise IngestDataError(PROCESSING_FAILED_MESSAGE)
    return schema, role


async def _fetch_content(get_content: GetContent, file: FileRow) -> bytes:
    content = await get_content(file)
    if len(content) > MAX_UPLOAD_BYTES:
        raise IngestDataError(PROCESSING_FAILED_MESSAGE)
    return content


def _index_name(table: str, column: str, used: set[str]) -> str:
    name = f"ix_{table}_{column}"
    if len(name) > 63 or name in used:
        digest = hashlib.sha256(f"{table}\x00{column}".encode()).hexdigest()[:8]
        name = f"{name[:54]}_{digest}"
    used.add(name)
    return name


def _describe_column(column: dict[str, Any]) -> dict[str, Any]:
    return {
        "ordinal": column["ordinal"],
        "columnName": column["column_name"],
        "originalHeader": column["original_header"],
        "dataType": column["data_type"],
        "dateFormat": column["date_format"],
        "isPercent": column["is_percent"],
        "isCandidateKey": column["is_candidate_key"],
        "nullPct": column["null_pct"],
        "distinctCount": column["distinct_count"],
        "minValue": column["min_value"],
        "maxValue": column["max_value"],
        "topValues": column["top_values"],
        "sampleValues": column["sample_values"],
    }


async def run_ingest_step(
    dataset_id: UUID,
    pool: asyncpg.Pool,
    *,
    get_content: GetContent,
    describe: DescribeFn,
    after_batch: AfterBatch | None = None,
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        try:
            async with conn.transaction():
                return await _advance(
                    PgIngestStore(conn), dataset_id, get_content, describe, after_batch
                )
        except IngestDataError:
            async with conn.transaction():
                await PgIngestStore(conn).mark_failed(dataset_id, PROCESSING_FAILED_MESSAGE)
            return {"status": "failed", "progress": 0}


async def _advance(
    store: Any,
    dataset_id: UUID,
    get_content: GetContent,
    describe: DescribeFn,
    after_batch: AfterBatch | None,
) -> dict[str, Any]:
    ds = await store.lock_dataset(dataset_id)
    if ds is None:
        raise DatasetNotFound
    if ds.status == "ready":
        return {"status": "ready", "progress": 100}
    if ds.status == "failed":
        return {"status": "failed", "progress": 0}
    if ds.status in ("uploaded", "profiling"):
        return await _profiling_step(store, ds, get_content)
    if ds.status == "loading":
        return await _loading_step(store, ds, get_content, after_batch)
    if ds.status == "describing":
        return await _describing_step(store, ds, describe)
    raise IngestDataError(PROCESSING_FAILED_MESSAGE)


async def _profiling_step(store: Any, ds: DatasetRow, get_content: GetContent) -> dict[str, Any]:
    files = await store.list_files(ds.id)
    if not files:
        raise IngestDataError(PROCESSING_FAILED_MESSAGE)
    pending = next((f for f in files if f.profile is None), None)
    if pending is not None:
        content = await _fetch_content(get_content, pending)
        profile = await asyncio.to_thread(_profile_upload, pending.original_name, content)
        await store.save_profile(pending.id, serialize_profile(profile), profile.row_count)
        await store.set_status(ds.id, "profiling")
        profiled = sum(1 for f in files if f.profile is not None) + 1
        return {"status": "profiling", "progress": round(profiled / len(files) * 100)}

    tables = [(f, deserialize_profile(f.profile)) for f in files]
    names = [f.table_name for f in files]
    if len(set(names)) != len(names):
        raise IngestDataError(PROCESSING_FAILED_MESSAGE)
    for file, profile in tables:
        _check_identifiers(file.table_name, [c.column_name for c in profile.columns])
    relationships: list[DetectedRelationship] = detect_relationships(
        {file.table_name: profile for file, profile in tables}
    )
    await store.insert_catalog(ds.id, tables, relationships)
    schema, role = derived_names(ds.id)
    await store.set_loading(ds.id, schema, role)
    return {"status": "loading", "progress": 0}


async def _loading_step(
    store: Any,
    ds: DatasetRow,
    get_content: GetContent,
    after_batch: AfterBatch | None,
) -> dict[str, Any]:
    schema, role = _stored_names(ds)
    files = await store.list_files(ds.id)
    catalog = await store.catalog_columns_by_table(ds.id)
    await store.ensure_loading_infra(schema, role, catalog)

    total = sum(f.row_count or 0 for f in files)
    file = next((f for f in files if (f.row_count or 0) > f.rows_loaded), None)
    if file is None:
        await store.grant_select(schema, role)
        used: set[str] = set()
        for table, column in sorted(set(await store.index_targets(ds.id))):
            await store.create_index(schema, table, column, _index_name(table, column, used))
        for table_name, _ in catalog:
            await store.analyze(schema, table_name)
        await store.set_status(ds.id, "describing")
        return {"status": "describing", "progress": 100}

    if file.profile is None:
        raise IngestDataError(PROCESSING_FAILED_MESSAGE)
    profile = deserialize_profile(file.profile)
    content = await _fetch_content(get_content, file)
    headers, rows = await asyncio.to_thread(_parse_upload, file.original_name, content)
    columns = [c.column_name for c in profile.columns]
    if [h["name"] for h in headers] != columns or len(rows) != (file.row_count or 0):
        raise IngestDataError(PROCESSING_FAILED_MESSAGE)

    pg_types = [_pg_type(c.data_type) for c in profile.columns]
    start = file.rows_loaded
    end = min(start + ROWS_PER_STEP, len(rows))
    for batch_index, batch_start in enumerate(range(start, end, INSERT_BATCH)):
        batch_end = min(batch_start + INSERT_BATCH, end)
        values = await asyncio.to_thread(_coerce_rows, rows[batch_start:batch_end], profile.columns)
        await store.insert_rows(schema, file.table_name, columns, pg_types, values)
        if after_batch is not None:
            await after_batch(batch_index)
    await store.set_rows_loaded(file.id, end)

    loaded = sum(f.rows_loaded for f in files if f.id != file.id) + end
    progress = 100 if total == 0 else round(loaded / total * 100)
    return {"status": "loading", "progress": progress}


async def _describing_step(store: Any, ds: DatasetRow, describe: DescribeFn) -> dict[str, Any]:
    tables: list[CatalogTableRow] = await store.catalog_tables(ds.id)
    pending = [t for t in tables if t.description is None]
    if not pending:
        await store.finish_search(ds.id)
        await store.set_status(ds.id, "ready")
        return {"status": "ready", "progress": 100}

    schema, _ = _stored_names(ds)
    table = pending[0]
    columns = await store.catalog_columns(table.id)
    sample_rows = await store.sample_rows(
        schema, table.table_name, [c["column_name"] for c in columns]
    )
    data = DescribeInput(
        table_name=table.table_name,
        columns=[_describe_column(c) for c in columns],
        sample_rows=sample_rows,
    )
    try:
        result = await describe(data)
    except Exception:
        result = None

    await store.set_table_description(
        table.id, result.table_description if result is not None else ""
    )
    if result is not None:
        known = {c["column_name"] for c in columns}
        for name, text in result.columns.items():
            if name in known and text:
                await store.set_column_description(table.id, name, text)

    done = len(tables) - len(pending) + 1
    return {"status": "describing", "progress": round(done / len(tables) * 100)}


def _as_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


class PgIngestStore:
    def __init__(self, conn: asyncpg.Connection) -> None:
        self._conn = conn

    async def lock_dataset(self, dataset_id: UUID) -> DatasetRow | None:
        try:
            row = await self._conn.fetchrow(
                """
                SELECT id, status, schema_name, role_name
                FROM public.datasets WHERE id = $1 FOR UPDATE NOWAIT
                """,
                dataset_id,
            )
        except asyncpg.LockNotAvailableError as exc:
            raise IngestBusy from exc
        if row is None:
            return None
        return DatasetRow(
            id=row["id"],
            status=row["status"],
            schema_name=row["schema_name"],
            role_name=row["role_name"],
        )

    async def list_files(self, dataset_id: UUID) -> list[FileRow]:
        rows = await self._conn.fetch(
            """
            SELECT id, storage_path, original_name, table_name, row_count, rows_loaded, profile
            FROM public.dataset_files WHERE dataset_id = $1
            ORDER BY original_name, id
            """,
            dataset_id,
        )
        return [
            FileRow(
                id=r["id"],
                storage_path=r["storage_path"],
                original_name=r["original_name"],
                table_name=r["table_name"],
                row_count=r["row_count"],
                rows_loaded=r["rows_loaded"],
                profile=r["profile"],
            )
            for r in rows
        ]

    async def save_profile(self, file_id: UUID, profile: dict[str, Any], row_count: int) -> None:
        await self._conn.execute(
            "UPDATE public.dataset_files SET profile = $2, row_count = $3 WHERE id = $1",
            file_id,
            profile,
            row_count,
        )

    async def set_rows_loaded(self, file_id: UUID, rows_loaded: int) -> None:
        await self._conn.execute(
            "UPDATE public.dataset_files SET rows_loaded = $2 WHERE id = $1",
            file_id,
            rows_loaded,
        )

    async def set_status(self, dataset_id: UUID, status: str) -> None:
        await self._conn.execute(
            "UPDATE public.datasets SET status = $2 WHERE id = $1", dataset_id, status
        )

    async def mark_failed(self, dataset_id: UUID, message: str) -> None:
        await self._conn.execute(
            "UPDATE public.datasets SET status = 'failed', error = $2 WHERE id = $1",
            dataset_id,
            message,
        )

    async def set_loading(self, dataset_id: UUID, schema: str, role: str) -> None:
        await self._conn.execute(
            """
            UPDATE public.datasets
            SET status = 'loading', schema_name = $2, role_name = $3
            WHERE id = $1
            """,
            dataset_id,
            schema,
            role,
        )

    async def insert_catalog(
        self,
        dataset_id: UUID,
        tables: list[tuple[FileRow, TableProfile]],
        relationships: list[DetectedRelationship],
    ) -> None:
        for file, profile in tables:
            table_id = await self._conn.fetchval(
                """
                INSERT INTO public.catalog_tables (dataset_id, table_name, original_file, row_count)
                VALUES ($1, $2, $3, $4) RETURNING id
                """,
                dataset_id,
                file.table_name,
                file.original_name,
                profile.row_count,
            )
            if profile.columns:
                await self._conn.executemany(
                    """
                    INSERT INTO public.catalog_columns (
                        table_id, ordinal, column_name, original_header, data_type, null_pct,
                        distinct_count, coerced_count, min_value, max_value, top_values,
                        sample_values, is_candidate_key, is_percent, date_format
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    """,
                    [
                        (
                            table_id,
                            c.ordinal,
                            c.column_name,
                            c.original_header,
                            c.data_type,
                            c.null_pct,
                            c.distinct_count,
                            c.coerced_count,
                            c.min_value,
                            c.max_value,
                            c.top_values,
                            c.sample_values,
                            c.is_candidate_key,
                            c.is_percent,
                            c.date_format,
                        )
                        for c in profile.columns
                    ],
                )
        if relationships:
            await self._conn.executemany(
                """
                INSERT INTO public.catalog_relationships
                    (dataset_id, from_table, from_column, to_table, to_column, overlap, method)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                """,
                [
                    (
                        dataset_id,
                        r.from_table,
                        r.from_column,
                        r.to_table,
                        r.to_column,
                        r.overlap,
                        r.method,
                    )
                    for r in relationships
                ],
            )

    async def catalog_columns_by_table(
        self, dataset_id: UUID
    ) -> list[tuple[str, list[tuple[str, str]]]]:
        rows = await self._conn.fetch(
            """
            SELECT t.table_name AS table_name, c.column_name AS column_name,
                   c.data_type AS data_type
            FROM public.catalog_tables t
            JOIN public.catalog_columns c ON c.table_id = t.id
            WHERE t.dataset_id = $1
            ORDER BY t.table_name, c.ordinal
            """,
            dataset_id,
        )
        grouped: dict[str, list[tuple[str, str]]] = {}
        for r in rows:
            grouped.setdefault(r["table_name"], []).append((r["column_name"], r["data_type"]))
        return list(grouped.items())

    async def ensure_loading_infra(
        self, schema: str, role: str, tables: list[tuple[str, list[tuple[str, str]]]]
    ) -> None:
        conn = self._conn
        await conn.execute(f"CREATE SCHEMA IF NOT EXISTS {quote_ident(schema)}")
        role_exists = await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)", role
        )
        if not role_exists:
            await conn.execute(f"CREATE ROLE {quote_ident(role)} NOLOGIN")
        await conn.execute(f"GRANT USAGE ON SCHEMA {quote_ident(schema)} TO {quote_ident(role)}")
        await conn.execute(
            f"GRANT {quote_ident(role)} TO {quote_ident(QP_QUERY_ROLE)} "
            "WITH INHERIT FALSE, SET TRUE"
        )
        for table_name, columns in tables:
            if not columns:
                continue
            definitions = ", ".join(
                f"{quote_ident(name)} {_pg_type(data_type)}" for name, data_type in columns
            )
            await conn.execute(
                f"CREATE TABLE IF NOT EXISTS {quote_ident(schema)}.{quote_ident(table_name)} "
                f"({definitions})"
            )

    async def grant_select(self, schema: str, role: str) -> None:
        await self._conn.execute(
            f"GRANT SELECT ON ALL TABLES IN SCHEMA {quote_ident(schema)} TO {quote_ident(role)}"
        )

    async def index_targets(self, dataset_id: UUID) -> list[tuple[str, str]]:
        rows = await self._conn.fetch(
            """
            SELECT t.table_name AS table_name, c.column_name AS column_name
            FROM public.catalog_columns c
            JOIN public.catalog_tables t ON t.id = c.table_id
            WHERE t.dataset_id = $1 AND c.is_candidate_key
            UNION
            SELECT from_table AS table_name, from_column AS column_name
            FROM public.catalog_relationships WHERE dataset_id = $1
            """,
            dataset_id,
        )
        return [(r["table_name"], r["column_name"]) for r in rows]

    async def create_index(self, schema: str, table: str, column: str, name: str) -> None:
        await self._conn.execute(
            f"CREATE INDEX IF NOT EXISTS {quote_ident(name)} "
            f"ON {quote_ident(schema)}.{quote_ident(table)} ({quote_ident(column)})"
        )

    async def analyze(self, schema: str, table: str) -> None:
        await self._conn.execute(f"ANALYZE {quote_ident(schema)}.{quote_ident(table)}")

    async def insert_rows(
        self,
        schema: str,
        table: str,
        columns: list[str],
        pg_types: list[str],
        rows: list[tuple[str | None, ...]],
    ) -> None:
        target = f"{quote_ident(schema)}.{quote_ident(table)}"
        names = ", ".join(quote_ident(c) for c in columns)
        params = ", ".join(f"${i}::text::{t}" for i, t in enumerate(pg_types, start=1))
        sql = statement("INSERT INTO", target, f"({names})", f"VALUES ({params})")
        await self._conn.executemany(sql, rows)

    async def catalog_tables(self, dataset_id: UUID) -> list[CatalogTableRow]:
        rows = await self._conn.fetch(
            """
            SELECT id, table_name, description FROM public.catalog_tables
            WHERE dataset_id = $1 ORDER BY table_name
            """,
            dataset_id,
        )
        return [
            CatalogTableRow(id=r["id"], table_name=r["table_name"], description=r["description"])
            for r in rows
        ]

    async def catalog_columns(self, table_id: UUID) -> list[dict[str, Any]]:
        rows = await self._conn.fetch(
            """
            SELECT ordinal, column_name, original_header, data_type, date_format,
                   is_percent, is_candidate_key, null_pct, distinct_count,
                   min_value, max_value, top_values, sample_values
            FROM public.catalog_columns WHERE table_id = $1 ORDER BY ordinal
            """,
            table_id,
        )
        return [dict(r) for r in rows]

    async def sample_rows(self, schema: str, table: str, columns: list[str]) -> list[list[str]]:
        if not columns:
            return []
        target = f"{quote_ident(schema)}.{quote_ident(table)}"
        names = ", ".join(quote_ident(c) for c in columns)
        sql = statement("SELECT", names, "FROM", target, f"LIMIT {SAMPLE_ROW_LIMIT}")
        rows = await self._conn.fetch(sql)
        return [[_as_text(r[c]) for c in columns] for r in rows]

    async def set_table_description(self, table_id: UUID, description: str) -> None:
        await self._conn.execute(
            "UPDATE public.catalog_tables SET description = $2 WHERE id = $1",
            table_id,
            description,
        )

    async def set_column_description(
        self, table_id: UUID, column_name: str, description: str
    ) -> None:
        await self._conn.execute(
            """
            UPDATE public.catalog_columns SET description = $3
            WHERE table_id = $1 AND column_name = $2
            """,
            table_id,
            column_name,
            description,
        )

    async def finish_search(self, dataset_id: UUID) -> None:
        await self._conn.execute(
            """
            UPDATE public.catalog_tables
            SET search = to_tsvector('english',
                coalesce(table_name, '') || ' ' || coalesce(description, ''))
            WHERE dataset_id = $1
            """,
            dataset_id,
        )
        await self._conn.execute(
            """
            UPDATE public.catalog_columns c
            SET search = to_tsvector('english',
                coalesce(c.column_name, '') || ' ' || coalesce(c.original_header, '')
                || ' ' || coalesce(c.description, ''))
            FROM public.catalog_tables t
            WHERE c.table_id = t.id AND t.dataset_id = $1
            """,
            dataset_id,
        )
