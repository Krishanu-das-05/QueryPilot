import hmac
from typing import Annotated, Any
from uuid import UUID, uuid4

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from ..catalog import get_dataset_catalog
from ..config import ALLOWED_UPLOAD_EXTENSIONS, MAX_FILES_PER_DATASET, MAX_UPLOAD_BYTES, Settings
from ..db import get_pool
from ..ingest.describe import DescribeFn, get_describer
from ..ingest.pipeline import FileRow, run_ingest_step
from ..ingest.tablename import table_name_for_file
from ..storage import (
    StoredObjectTooLarge,
    SupabaseStorage,
    get_storage,
    safe_upload_name,
    storage_path_is_valid,
)

router = APIRouter()

PoolDep = Annotated[asyncpg.Pool, Depends(get_pool)]
StorageDep = Annotated[SupabaseStorage, Depends(get_storage)]


def require_passphrase(request: Request) -> None:
    settings: Settings | None = request.app.state.settings
    expected = settings.upload_passphrase if settings is not None else None
    given = request.headers.get("x-upload-passphrase")
    if (
        not expected
        or given is None
        or not hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8"))
    ):
        raise HTTPException(status_code=401, detail="unauthorized")


def _check_extension(name: str) -> str:
    if not name.lower().endswith(ALLOWED_UPLOAD_EXTENSIONS):
        raise ValueError("unsupported file type")
    return name


def _invalid_request() -> HTTPException:
    return HTTPException(status_code=400, detail="invalid request")


class _Body(BaseModel):
    model_config = ConfigDict(
        extra="forbid", strict=True, alias_generator=to_camel, populate_by_name=True
    )


class CreateDataset(_Body):
    name: str = Field(min_length=1, max_length=200)


class UploadUrlRequest(_Body):
    file_name: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0, le=MAX_UPLOAD_BYTES)

    @field_validator("file_name")
    @classmethod
    def _extension(cls, value: str) -> str:
        return _check_extension(value)


class FileRegistration(_Body):
    storage_path: str = Field(min_length=1, max_length=500)
    original_name: str = Field(min_length=1, max_length=255)
    size_bytes: int = Field(gt=0, le=MAX_UPLOAD_BYTES)

    @field_validator("original_name")
    @classmethod
    def _extension(cls, value: str) -> str:
        return _check_extension(value)


class DescriptionPatch(_Body):
    table_id: UUID | None = Field(default=None, strict=False)
    column_id: UUID | None = Field(default=None, strict=False)
    description: str = Field(max_length=2000)

    @model_validator(mode="after")
    def _exactly_one_target(self) -> "DescriptionPatch":
        if (self.table_id is None) == (self.column_id is None):
            raise ValueError("exactly one of tableId/columnId required")
        return self


@router.get("")
async def list_datasets(pool: PoolDep) -> list[dict[str, Any]]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, name, status, error, is_demo, created_at, expires_at
            FROM public.datasets ORDER BY created_at DESC
            """
        )
    return [dict(r) for r in rows]


@router.post("", dependencies=[Depends(require_passphrase)])
async def create_dataset(body: CreateDataset, pool: PoolDep) -> dict[str, Any]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO public.datasets (name, status) VALUES ($1, 'uploaded') RETURNING id",
            body.name,
        )
    return {"id": row["id"]}


@router.get("/{dataset_id}")
async def get_catalog(dataset_id: UUID, pool: PoolDep) -> dict[str, Any]:
    async with pool.acquire() as conn:
        catalog = await get_dataset_catalog(conn, dataset_id)
    if catalog is None:
        raise HTTPException(status_code=404, detail="not found")
    return catalog


@router.patch("/{dataset_id}", dependencies=[Depends(require_passphrase)])
async def update_description(
    dataset_id: UUID, body: DescriptionPatch, pool: PoolDep
) -> dict[str, bool]:
    async with pool.acquire() as conn:
        if body.table_id is not None:
            row = await conn.fetchrow(
                """
                UPDATE public.catalog_tables
                SET description = $3::text,
                    description_edited = true,
                    search = to_tsvector('english',
                        coalesce(table_name, '') || ' ' || $3::text)
                WHERE id = $1 AND dataset_id = $2
                RETURNING id
                """,
                body.table_id,
                dataset_id,
                body.description,
            )
        else:
            row = await conn.fetchrow(
                """
                UPDATE public.catalog_columns c
                SET description = $3::text,
                    search = to_tsvector('english',
                        coalesce(c.column_name, '') || ' ' || coalesce(c.original_header, '')
                        || ' ' || $3::text)
                FROM public.catalog_tables t
                WHERE c.id = $1 AND c.table_id = t.id AND t.dataset_id = $2
                RETURNING c.id
                """,
                body.column_id,
                dataset_id,
                body.description,
            )
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


@router.post("/{dataset_id}/upload-url", dependencies=[Depends(require_passphrase)])
async def create_upload_url(
    dataset_id: UUID, body: UploadUrlRequest, pool: PoolDep, storage: StorageDep
) -> dict[str, str]:
    path = f"{dataset_id}/{uuid4()}-{safe_upload_name(body.file_name)}"
    async with pool.acquire() as conn, conn.transaction():
        dataset = await conn.fetchrow(
            "SELECT status FROM public.datasets WHERE id = $1 FOR UPDATE", dataset_id
        )
        if dataset is None:
            raise HTTPException(status_code=404, detail="not found")
        if dataset["status"] != "uploaded":
            raise HTTPException(status_code=409, detail="dataset is not accepting uploads")
        count = await conn.fetchval(
            "SELECT count(*) FROM public.dataset_files WHERE dataset_id = $1", dataset_id
        )
        if count >= MAX_FILES_PER_DATASET:
            raise HTTPException(
                status_code=400, detail=f"a dataset can have at most {MAX_FILES_PER_DATASET} files"
            )
        signed = await storage.create_signed_upload(path)
    return {"path": signed.path, "token": signed.token}


@router.post("/{dataset_id}/files", dependencies=[Depends(require_passphrase)])
async def register_file(
    dataset_id: UUID, body: FileRegistration, pool: PoolDep, storage: StorageDep
) -> dict[str, Any]:
    if not storage_path_is_valid(body.storage_path, dataset_id):
        raise _invalid_request()
    async with pool.acquire() as conn, conn.transaction():
        dataset = await conn.fetchrow(
            "SELECT status FROM public.datasets WHERE id = $1 FOR UPDATE", dataset_id
        )
        if dataset is None:
            raise HTTPException(status_code=404, detail="not found")
        if dataset["status"] != "uploaded":
            raise HTTPException(status_code=409, detail="dataset is not accepting uploads")
        existing = await conn.fetch(
            "SELECT table_name, storage_path FROM public.dataset_files WHERE dataset_id = $1",
            dataset_id,
        )
        if len(existing) >= MAX_FILES_PER_DATASET:
            raise HTTPException(
                status_code=400, detail=f"a dataset can have at most {MAX_FILES_PER_DATASET} files"
            )
        if any(r["storage_path"] == body.storage_path for r in existing):
            raise HTTPException(status_code=409, detail="file already registered")
        try:
            content = await storage.download(body.storage_path)
        except StoredObjectTooLarge:
            raise HTTPException(
                status_code=400, detail="uploaded file exceeds the size limit"
            ) from None
        if len(content) != body.size_bytes:
            raise HTTPException(status_code=400, detail="uploaded file size does not match")
        taken = {r["table_name"] for r in existing if r["table_name"]}
        table_name = table_name_for_file(body.original_name, taken)
        row = await conn.fetchrow(
            """
            INSERT INTO public.dataset_files
                (dataset_id, storage_path, original_name, size_bytes, table_name)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, table_name
            """,
            dataset_id,
            body.storage_path,
            body.original_name,
            body.size_bytes,
            table_name,
        )
    return {"id": row["id"], "tableName": row["table_name"]}


@router.post("/{dataset_id}/ingest/next", dependencies=[Depends(require_passphrase)])
async def ingest_next(
    dataset_id: UUID,
    pool: PoolDep,
    storage: StorageDep,
    describe: Annotated[DescribeFn, Depends(get_describer)],
) -> dict[str, Any]:
    async def get_content(file: FileRow) -> bytes:
        return await storage.download(file.storage_path)

    return await run_ingest_step(dataset_id, pool, get_content=get_content, describe=describe)
