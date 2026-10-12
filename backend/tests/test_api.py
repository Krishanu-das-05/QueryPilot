from datetime import UTC, datetime
from uuid import UUID

import asyncpg
import pytest
from fastapi.testclient import TestClient

from app.api import datasets as datasets_api
from app.config import MAX_UPLOAD_BYTES, Settings
from app.db import get_pool
from app.ingest.pipeline import DatasetNotFound, IngestBusy
from app.main import create_app
from app.storage import (
    SignedUpload,
    StorageError,
    StoredObjectTooLarge,
    get_storage,
    storage_path_is_valid,
)
from tests.doubles import FakeConnection, FakePool, fake_secret

PASSPHRASE = fake_secret()
FAKE_TOKEN = fake_secret()
HEADERS = {"x-upload-passphrase": PASSPHRASE}
DATASET_ID = "11111111-2222-4333-8444-555555555555"
CONTENT = b"id,name\n1,a\n"


class FakeStorage:
    def __init__(self, content: bytes = CONTENT) -> None:
        self.content = content
        self.signed_paths: list[str] = []
        self.error: Exception | None = None

    async def create_signed_upload(self, path: str) -> SignedUpload:
        if self.error is not None:
            raise self.error
        if not storage_path_is_valid(path, UUID(DATASET_ID)):
            raise AssertionError("route generated a path the storage validator rejects")
        self.signed_paths.append(path)
        return SignedUpload(path=path, token=FAKE_TOKEN)

    async def download(self, path: str) -> bytes:
        if self.error is not None:
            raise self.error
        return self.content


def make_client(
    script: dict | None = None,
    storage: FakeStorage | None = None,
    settings: Settings | None = None,
) -> tuple[TestClient, FakeConnection]:
    conn = FakeConnection(script)
    app = create_app(settings or Settings(upload_passphrase=PASSPHRASE))
    app.dependency_overrides[get_pool] = lambda: FakePool(conn)
    app.dependency_overrides[get_storage] = lambda: storage or FakeStorage()
    return TestClient(app, raise_server_exceptions=False), conn


def dataset_path(name: str = "data.csv") -> str:
    return f"{DATASET_ID}/abc-{name}"


def test_health_needs_no_configuration_or_database():
    client = TestClient(create_app(Settings()))
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_missing_database_is_safe_service_unavailable():
    app = create_app(Settings(upload_passphrase=PASSPHRASE))
    client = TestClient(app, raise_server_exceptions=False)
    response = client.get("/api/datasets")
    assert response.status_code == 503
    assert response.json() == {"error": "service unavailable"}


def test_writes_with_wrong_or_missing_passphrase_are_unauthorized():
    client, conn = make_client({})
    wrong = client.post(
        "/api/datasets", json={"name": "x"}, headers={"x-upload-passphrase": "nope"}
    )
    missing = client.post("/api/datasets", json={"name": "x"})
    for response in (wrong, missing):
        assert response.status_code == 401
        assert response.json() == {"error": "unauthorized"}
    assert conn.calls == []


def test_writes_are_rejected_when_no_passphrase_is_configured():
    client, conn = make_client({}, settings=Settings())
    response = client.post("/api/datasets", json={"name": "x"}, headers={"x-upload-passphrase": ""})
    assert response.status_code == 401
    assert conn.calls == []


def test_list_datasets_returns_expected_fields():
    row = {
        "id": UUID(DATASET_ID),
        "name": "sales",
        "status": "ready",
        "error": None,
        "is_demo": False,
        "created_at": datetime(2024, 1, 1, tzinfo=UTC),
        "expires_at": datetime(2024, 1, 8, tzinfo=UTC),
    }
    client, _ = make_client({"SELECT id, name, status, error, is_demo": [row]})
    response = client.get("/api/datasets")
    assert response.status_code == 200
    assert set(response.json()[0]) == {
        "id",
        "name",
        "status",
        "error",
        "is_demo",
        "created_at",
        "expires_at",
    }


def test_create_dataset_returns_id():
    client, conn = make_client({"INSERT INTO public.datasets": {"id": UUID(DATASET_ID)}})
    response = client.post("/api/datasets", json={"name": "sales"}, headers=HEADERS)
    assert response.status_code == 200
    assert response.json() == {"id": DATASET_ID}
    assert conn.calls[0][1] == ("sales",)


@pytest.mark.parametrize(
    "body",
    [{"name": ""}, {"name": "x" * 201}, {"name": "x", "extra": 1}, {"name": 5}],
)
def test_create_rejects_invalid_body(body):
    client, _ = make_client({})
    response = client.post("/api/datasets", json=body, headers=HEADERS)
    assert response.status_code == 400
    assert response.json() == {"error": "invalid request"}


def test_invalid_uuid_path_is_bad_request():
    client, _ = make_client({})
    response = client.get("/api/datasets/not-a-uuid")
    assert response.status_code == 400
    assert response.json() == {"error": "invalid request"}


def test_catalog_success_has_expected_shape_without_storage_paths():
    script = {
        "SELECT id, name, status, error, schema_name": {
            "id": UUID(DATASET_ID),
            "name": "sales",
            "status": "ready",
            "error": None,
            "schema_name": "ds_11111111",
            "is_demo": False,
            "created_at": datetime(2024, 1, 1, tzinfo=UTC),
            "expires_at": datetime(2024, 1, 8, tzinfo=UTC),
        },
        "SELECT id, original_name": [
            {
                "id": UUID(DATASET_ID),
                "original_name": "data.csv",
                "size_bytes": 12,
                "table_name": "data",
                "row_count": 1,
                "rows_loaded": 1,
            }
        ],
        "SELECT id, table_name, original_file": [],
        "SELECT id, table_id, ordinal": [],
        "SELECT from_table, from_column": [],
    }
    client, _ = make_client(script)
    response = client.get(f"/api/datasets/{DATASET_ID}")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"dataset", "files", "tables", "columns", "relationships"}
    assert "storage_path" not in body["files"][0]
    assert body["files"][0]["table_name"] == "data"


def test_catalog_missing_dataset_is_not_found():
    client, _ = make_client({"SELECT id, name, status, error, schema_name": None})
    response = client.get(f"/api/datasets/{DATASET_ID}")
    assert response.status_code == 404
    assert response.json() == {"error": "not found"}


def test_patch_table_is_scoped_to_dataset():
    table_id = "66666666-7777-4888-8999-aaaaaaaaaaaa"
    client, conn = make_client({"UPDATE public.catalog_tables": {"id": UUID(table_id)}})
    response = client.patch(
        f"/api/datasets/{DATASET_ID}",
        json={"tableId": table_id, "description": "Sales"},
        headers=HEADERS,
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    sql, args = conn.calls[0]
    assert "dataset_id = $2" in sql
    assert args[1] == UUID(DATASET_ID)


def test_patch_other_dataset_target_is_not_found():
    table_id = "66666666-7777-4888-8999-aaaaaaaaaaaa"
    client, _ = make_client({"UPDATE public.catalog_tables": None})
    response = client.patch(
        f"/api/datasets/{DATASET_ID}",
        json={"tableId": table_id, "description": "Sales"},
        headers=HEADERS,
    )
    assert response.status_code == 404
    assert response.json() == {"error": "not found"}


def test_patch_column_is_scoped_through_table_dataset():
    column_id = "77777777-8888-4999-8aaa-bbbbbbbbbbbb"
    client, conn = make_client({"UPDATE public.catalog_columns c": {"id": UUID(column_id)}})
    response = client.patch(
        f"/api/datasets/{DATASET_ID}",
        json={"columnId": column_id, "description": "Amount"},
        headers=HEADERS,
    )
    assert response.status_code == 200
    sql, args = conn.calls[0]
    assert "t.dataset_id = $2" in sql
    assert args[1] == UUID(DATASET_ID)


@pytest.mark.parametrize(
    "body",
    [
        {"description": "x"},
        {
            "tableId": "66666666-7777-4888-8999-aaaaaaaaaaaa",
            "columnId": "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
            "description": "x",
        },
        {"tableId": "66666666-7777-4888-8999-aaaaaaaaaaaa", "description": "x" * 2001},
    ],
)
def test_patch_rejects_ambiguous_or_oversized_body(body):
    client, _ = make_client({})
    response = client.patch(f"/api/datasets/{DATASET_ID}", json=body, headers=HEADERS)
    assert response.status_code == 400
    assert response.json() == {"error": "invalid request"}


def test_upload_url_returns_scoped_path_and_token():
    storage = FakeStorage()
    client, _ = make_client({"FOR UPDATE": {"status": "uploaded"}, "count(*)": 0}, storage)
    response = client.post(
        f"/api/datasets/{DATASET_ID}/upload-url",
        json={"fileName": "data.CSV", "size": 12},
        headers=HEADERS,
    )
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"path", "token"}
    assert body["path"].startswith(f"{DATASET_ID}/")
    assert body["path"].endswith("-data.CSV")
    assert body["token"] == FAKE_TOKEN
    assert storage.signed_paths == [body["path"]]


@pytest.mark.parametrize(
    "name",
    ["sales..2024.csv", "DATA.CSV", "my file (1).xlsx", "x" * 251 + ".csv"],
)
def test_generated_upload_paths_satisfy_the_storage_validator(name):
    client, _ = make_client({"FOR UPDATE": {"status": "uploaded"}, "count(*)": 0})
    response = client.post(
        f"/api/datasets/{DATASET_ID}/upload-url",
        json={"fileName": name, "size": 12},
        headers=HEADERS,
    )
    assert response.status_code == 200
    assert storage_path_is_valid(response.json()["path"], UUID(DATASET_ID))


@pytest.mark.parametrize(
    "body",
    [
        {"fileName": "data.txt", "size": 12},
        {"fileName": "data.csv", "size": 0},
        {"fileName": "data.csv", "size": MAX_UPLOAD_BYTES + 1},
        {"fileName": "", "size": 12},
    ],
)
def test_upload_url_rejects_bad_extension_or_size(body):
    client, conn = make_client({})
    response = client.post(f"/api/datasets/{DATASET_ID}/upload-url", json=body, headers=HEADERS)
    assert response.status_code == 400
    assert response.json() == {"error": "invalid request"}
    assert conn.calls == []


def test_upload_url_unknown_dataset_is_not_found():
    client, _ = make_client({"FOR UPDATE": None})
    response = client.post(
        f"/api/datasets/{DATASET_ID}/upload-url",
        json={"fileName": "data.csv", "size": 12},
        headers=HEADERS,
    )
    assert response.status_code == 404


def test_upload_url_after_ingest_started_is_conflict():
    client, _ = make_client({"FOR UPDATE": {"status": "profiling"}})
    response = client.post(
        f"/api/datasets/{DATASET_ID}/upload-url",
        json={"fileName": "data.csv", "size": 12},
        headers=HEADERS,
    )
    assert response.status_code == 409


def test_upload_url_rejects_sixth_file():
    client, _ = make_client({"FOR UPDATE": {"status": "uploaded"}, "count(*)": 5})
    response = client.post(
        f"/api/datasets/{DATASET_ID}/upload-url",
        json={"fileName": "data.csv", "size": 12},
        headers=HEADERS,
    )
    assert response.status_code == 400


def test_upload_url_storage_failure_is_sanitized():
    storage = FakeStorage()
    storage.error = StorageError(PASSPHRASE)
    client, _ = make_client({"FOR UPDATE": {"status": "uploaded"}, "count(*)": 0}, storage)
    response = client.post(
        f"/api/datasets/{DATASET_ID}/upload-url",
        json={"fileName": "data.csv", "size": 12},
        headers=HEADERS,
    )
    assert response.status_code == 503
    assert response.json() == {"error": "service unavailable"}
    assert PASSPHRASE not in response.text


def _register_script(existing: list | None = None, row: dict | None = None) -> dict:
    return {
        "FOR UPDATE": {"status": "uploaded"},
        "SELECT table_name, storage_path": existing if existing is not None else [],
        "INSERT INTO public.dataset_files": row
        or {"id": UUID("88888888-9999-4aaa-8bbb-cccccccccccc"), "table_name": "data"},
    }


def _register_body(
    path: str | None = None, size: int | None = None, name: str = "data.csv"
) -> dict:
    return {
        "storagePath": path or dataset_path(),
        "originalName": name,
        "sizeBytes": size if size is not None else len(CONTENT),
    }


def test_register_file_success_returns_table_name():
    client, _ = make_client(_register_script())
    response = client.post(
        f"/api/datasets/{DATASET_ID}/files", json=_register_body(), headers=HEADERS
    )
    assert response.status_code == 200
    assert response.json() == {"id": "88888888-9999-4aaa-8bbb-cccccccccccc", "tableName": "data"}


def test_register_uses_deduplicated_table_name():
    existing = [{"table_name": "data", "storage_path": "other"}]
    client, conn = make_client(_register_script(existing=existing))
    client.post(f"/api/datasets/{DATASET_ID}/files", json=_register_body(), headers=HEADERS)
    insert_args = next(
        args for sql, args in conn.calls if "INSERT INTO public.dataset_files" in sql
    )
    assert insert_args[4] == "data_2"


@pytest.mark.parametrize(
    "path",
    [
        f"{DATASET_ID}/../escape.csv",
        f"{DATASET_ID}\\x.csv",
        f"{DATASET_ID}//x.csv",
        "99999999-9999-4999-8999-999999999999/x.csv",
    ],
)
def test_register_rejects_bad_storage_paths(path):
    client, conn = make_client(_register_script())
    response = client.post(
        f"/api/datasets/{DATASET_ID}/files", json=_register_body(path=path), headers=HEADERS
    )
    assert response.status_code == 400
    assert response.json() == {"error": "invalid request"}
    assert conn.calls == []


def test_register_rejects_bad_extension():
    client, _ = make_client(_register_script())
    response = client.post(
        f"/api/datasets/{DATASET_ID}/files",
        json=_register_body(name="data.txt"),
        headers=HEADERS,
    )
    assert response.status_code == 400


def test_register_duplicate_storage_path_conflicts():
    existing = [{"table_name": "data", "storage_path": dataset_path()}]
    client, _ = make_client(_register_script(existing=existing))
    response = client.post(
        f"/api/datasets/{DATASET_ID}/files", json=_register_body(), headers=HEADERS
    )
    assert response.status_code == 409


def test_register_actual_size_mismatch_is_rejected():
    client, conn = make_client(_register_script())
    response = client.post(
        f"/api/datasets/{DATASET_ID}/files",
        json=_register_body(size=len(CONTENT) + 5),
        headers=HEADERS,
    )
    assert response.status_code == 400
    assert response.json() == {"error": "uploaded file size does not match"}
    assert not any("INSERT INTO" in sql for sql, _ in conn.calls)


def test_register_oversized_stored_object_is_rejected():
    storage = FakeStorage()
    storage.error = StoredObjectTooLarge("too big")
    client, _ = make_client(_register_script(), storage)
    response = client.post(
        f"/api/datasets/{DATASET_ID}/files", json=_register_body(), headers=HEADERS
    )
    assert response.status_code == 400


def test_register_sixth_file_is_rejected():
    existing = [{"table_name": f"t{i}", "storage_path": f"x{i}"} for i in range(5)]
    client, _ = make_client(_register_script(existing=existing))
    response = client.post(
        f"/api/datasets/{DATASET_ID}/files", json=_register_body(), headers=HEADERS
    )
    assert response.status_code == 400


def test_register_when_not_uploaded_conflicts():
    script = _register_script()
    script["FOR UPDATE"] = {"status": "ready"}
    client, _ = make_client(script)
    response = client.post(
        f"/api/datasets/{DATASET_ID}/files", json=_register_body(), headers=HEADERS
    )
    assert response.status_code == 409


def test_register_storage_failure_is_sanitized_unavailable():
    storage = FakeStorage()
    storage.error = StorageError(PASSPHRASE)
    client, _ = make_client(_register_script(), storage)
    response = client.post(
        f"/api/datasets/{DATASET_ID}/files", json=_register_body(), headers=HEADERS
    )
    assert response.status_code == 503
    assert PASSPHRASE not in response.text


def test_ingest_next_returns_step_result(monkeypatch):
    async def fake_step(dataset_id, pool, *, get_content, describe, after_batch=None):
        return {"status": "profiling", "progress": 50}

    monkeypatch.setattr(datasets_api, "run_ingest_step", fake_step)
    client, _ = make_client({})
    response = client.post(f"/api/datasets/{DATASET_ID}/ingest/next", headers=HEADERS)
    assert response.status_code == 200
    assert response.json() == {"status": "profiling", "progress": 50}


def test_ingest_next_requires_passphrase():
    client, _ = make_client({})
    response = client.post(f"/api/datasets/{DATASET_ID}/ingest/next")
    assert response.status_code == 401


def test_ingest_busy_is_conflict_without_detail(monkeypatch):
    async def busy_step(dataset_id, pool, *, get_content, describe, after_batch=None):
        raise IngestBusy(PASSPHRASE)

    monkeypatch.setattr(datasets_api, "run_ingest_step", busy_step)
    client, _ = make_client({})
    response = client.post(f"/api/datasets/{DATASET_ID}/ingest/next", headers=HEADERS)
    assert response.status_code == 409
    assert response.json() == {"error": "ingest already in progress"}
    assert PASSPHRASE not in response.text


def test_ingest_transient_database_failure_is_sanitized_unavailable(monkeypatch):
    async def flaky_step(dataset_id, pool, *, get_content, describe, after_batch=None):
        raise asyncpg.PostgresError(PASSPHRASE)

    monkeypatch.setattr(datasets_api, "run_ingest_step", flaky_step)
    client, _ = make_client({})
    response = client.post(f"/api/datasets/{DATASET_ID}/ingest/next", headers=HEADERS)
    assert response.status_code == 503
    assert response.json() == {"error": "service unavailable"}
    assert PASSPHRASE not in response.text


def test_ingest_unknown_dataset_is_not_found(monkeypatch):
    async def missing_step(dataset_id, pool, *, get_content, describe, after_batch=None):
        raise DatasetNotFound

    monkeypatch.setattr(datasets_api, "run_ingest_step", missing_step)
    client, _ = make_client({})
    response = client.post(f"/api/datasets/{DATASET_ID}/ingest/next", headers=HEADERS)
    assert response.status_code == 404
    assert response.json() == {"error": "not found"}


def test_unhandled_failure_is_generic_internal_error(monkeypatch):
    async def broken_step(dataset_id, pool, *, get_content, describe, after_batch=None):
        raise RuntimeError(PASSPHRASE)

    monkeypatch.setattr(datasets_api, "run_ingest_step", broken_step)
    client, _ = make_client({})
    response = client.post(f"/api/datasets/{DATASET_ID}/ingest/next", headers=HEADERS)
    assert response.status_code == 500
    assert response.json() == {"error": "internal server error"}
    assert PASSPHRASE not in response.text
