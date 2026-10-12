import asyncio
import json
import logging

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config as config_module
from app import db as db_module
from app import main as main_module
from app.api import datasets as datasets_api
from app.config import REPO_ROOT, Settings
from app.db import get_pool
from app.main import UnhandledErrorBoundary, create_app
from app.storage import get_storage
from tests.doubles import FakeConnection, FakePool, fake_secret

DATASET_ID = "11111111-2222-4333-8444-555555555555"


def test_settings_repr_hides_every_secret():
    secrets = {
        "database_url_admin": fake_secret(),
        "database_url_query": fake_secret(),
        "qp_query_password": fake_secret(),
        "supabase_url": fake_secret(),
        "supabase_service_role_key": fake_secret(),
        "upload_passphrase": fake_secret(),
        "openrouter_api_key": fake_secret(),
    }
    settings = Settings(**secrets, openrouter_model="visible/model")
    text = repr(settings)
    for value in secrets.values():
        assert value not in text
    assert "visible/model" in text


def test_from_env_maps_names_and_treats_empty_values_as_unset():
    env = {
        "DATABASE_URL_ADMIN": fake_secret(),
        "UPLOAD_PASSPHRASE": fake_secret(),
        "QP_QUERY_PASSWORD": fake_secret(),
        "OPENROUTER_MODEL": "model/a",
        "OPENROUTER_FALLBACK_MODEL": "",
    }
    settings = Settings.from_env(env)
    assert settings.database_url_admin == env["DATABASE_URL_ADMIN"]
    assert settings.upload_passphrase == env["UPLOAD_PASSPHRASE"]
    assert settings.qp_query_password == env["QP_QUERY_PASSWORD"]
    assert settings.openrouter_model == "model/a"
    assert settings.openrouter_fallback_model is None


def test_startup_settings_read_repo_env_file_without_override(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(
        config_module, "load_dotenv", lambda path, override: calls.append((path, override))
    )
    config_module.settings_from_startup()
    assert calls == [(REPO_ROOT / ".env.local", False)]


def test_creating_apps_never_loads_environment_files(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(config_module, "load_dotenv", lambda path, override: calls.append(path))
    create_app()
    create_app(Settings())
    assert calls == []


async def test_default_app_loads_startup_settings_only_in_lifespan(monkeypatch):
    loaded: list[bool] = []

    def startup() -> Settings:
        loaded.append(True)
        return Settings()

    monkeypatch.setattr(main_module, "settings_from_startup", startup)
    app = create_app()
    assert loaded == []
    async with app.router.lifespan_context(app):
        assert loaded == [True]
        assert isinstance(app.state.settings, Settings)


async def test_explicit_settings_are_kept_and_startup_is_not_called(monkeypatch):
    def forbidden() -> Settings:
        raise AssertionError("startup settings must not load when settings are explicit")

    monkeypatch.setattr(main_module, "settings_from_startup", forbidden)
    settings = Settings(upload_passphrase=fake_secret())
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        assert app.state.settings is settings


def test_default_module_app_is_built_without_startup_settings():
    assert isinstance(main_module.app, FastAPI)
    assert main_module.app.state.settings is None


async def test_admin_pool_uses_pooler_safe_settings(monkeypatch):
    captured: dict = {}

    async def fake_create_pool(**kwargs):
        captured.update(kwargs)
        return "POOL"

    monkeypatch.setattr(db_module.asyncpg, "create_pool", fake_create_pool)
    dsn = fake_secret()
    assert await db_module.create_admin_pool(dsn) == "POOL"
    assert captured["dsn"] == dsn
    assert captured["min_size"] == 0
    assert captured["max_size"] == 5
    assert captured["command_timeout"] == 30
    assert captured["statement_cache_size"] == 0
    assert captured["init"] is db_module._init_connection


async def test_connection_init_registers_jsonb_codec():
    class RecordingConnection:
        def __init__(self) -> None:
            self.codecs: list[tuple[str, dict]] = []

        async def set_type_codec(self, typename: str, **kwargs) -> None:
            self.codecs.append((typename, kwargs))

    conn = RecordingConnection()
    await db_module._init_connection(conn)
    ((typename, kwargs),) = conn.codecs
    assert typename == "jsonb"
    assert kwargs["encoder"] is json.dumps
    assert kwargs["decoder"] is json.loads
    assert kwargs["schema"] == "pg_catalog"


def tracking_http_clients(monkeypatch) -> list[httpx.AsyncClient]:
    created: list[httpx.AsyncClient] = []

    class TrackingClient(httpx.AsyncClient):
        def __init__(self, *args, **kwargs) -> None:
            super().__init__(*args, **kwargs)
            created.append(self)

    monkeypatch.setattr(main_module.httpx, "AsyncClient", TrackingClient)
    return created


class ClosingPool:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


async def test_lifespan_closes_pool_and_http_client_when_body_fails(monkeypatch):
    created = tracking_http_clients(monkeypatch)
    pool = ClosingPool()

    async def fake_pool(dsn: str) -> ClosingPool:
        return pool

    monkeypatch.setattr(main_module, "create_admin_pool", fake_pool)
    app = create_app(Settings(database_url_admin=fake_secret()))
    with pytest.raises(RuntimeError, match="body failed"):
        async with app.router.lifespan_context(app):
            raise RuntimeError("body failed")
    assert pool.closed
    assert created[0].is_closed


async def test_lifespan_closes_http_client_when_pool_creation_fails(monkeypatch):
    created = tracking_http_clients(monkeypatch)

    async def broken_pool(dsn: str) -> None:
        raise OSError("connection refused")

    monkeypatch.setattr(main_module, "create_admin_pool", broken_pool)
    app = create_app(Settings(database_url_admin=fake_secret()))
    with pytest.raises(OSError):
        async with app.router.lifespan_context(app):
            pass
    assert created[0].is_closed


def test_unexpected_error_returns_generic_500_and_logs_no_detail(monkeypatch, caplog):
    passphrase = fake_secret()
    leaked = fake_secret()

    async def broken_step(dataset_id, pool, *, get_content, describe, after_batch=None):
        raise RuntimeError(leaked)

    monkeypatch.setattr(datasets_api, "run_ingest_step", broken_step)
    app = create_app(Settings(upload_passphrase=passphrase))
    app.dependency_overrides[get_pool] = lambda: FakePool(FakeConnection({}))
    app.dependency_overrides[get_storage] = lambda: object()
    client = TestClient(app, raise_server_exceptions=True)
    with caplog.at_level(logging.DEBUG):
        response = client.post(
            f"/api/datasets/{DATASET_ID}/ingest/next",
            headers={"x-upload-passphrase": passphrase},
        )
    assert response.status_code == 500
    assert response.json() == {"error": "internal server error"}
    assert leaked not in response.text
    assert leaked not in caplog.text
    assert "Traceback" not in caplog.text
    assert [r.getMessage() for r in caplog.records if r.name == "app.request"] == ["request failed"]
    assert all(record.exc_info is None for record in caplog.records)


async def test_boundary_does_not_swallow_cancellation():
    async def cancelled(scope, receive, send):
        raise asyncio.CancelledError

    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    boundary = UnhandledErrorBoundary(cancelled)
    with pytest.raises(asyncio.CancelledError):
        await boundary({"type": "http"}, None, send)
    assert sent == []
