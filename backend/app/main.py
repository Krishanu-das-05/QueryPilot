import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg
import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .api.datasets import router as datasets_router
from .config import Settings, settings_from_startup
from .db import create_admin_pool
from .ingest.pipeline import DatasetNotFound, IngestBusy
from .storage import StorageError, SupabaseStorage

logger = logging.getLogger("app.request")
HTTP_TIMEOUT_SECONDS = 15.0
UNAVAILABLE = {"error": "service unavailable"}
INTERNAL_ERROR_BODY = b'{"error": "internal server error"}'


class UnhandledErrorBoundary:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        response_started = False

        async def tracking_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, receive, tracking_send)
        except Exception:
            logger.error("request failed")
            if response_started:
                return
            await send(
                {
                    "type": "http.response.start",
                    "status": 500,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(INTERNAL_ERROR_BODY)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": INTERNAL_ERROR_BODY})


def _supabase_storage(settings: Settings, client: httpx.AsyncClient) -> SupabaseStorage | None:
    url = settings.supabase_url
    key = settings.supabase_service_role_key
    if not url or not key or not url.startswith("https://"):
        return None
    return SupabaseStorage(client, url, key)


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    if app.state.settings is None:
        app.state.settings = settings_from_startup()
    settings: Settings = app.state.settings
    client = httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS, follow_redirects=False)
    pool: asyncpg.Pool | None = None
    try:
        if settings.database_url_admin:
            pool = await create_admin_pool(settings.database_url_admin)
        app.state.pool = pool
        app.state.http = client
        app.state.storage = _supabase_storage(settings, client)
        yield
    finally:
        try:
            if pool is not None:
                await pool.close()
        finally:
            await client.aclose()


def _register_handlers(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({"error": "invalid request"}, status_code=400)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    @app.exception_handler(IngestBusy)
    async def ingest_busy(_request: Request, _exc: IngestBusy) -> JSONResponse:
        return JSONResponse({"error": "ingest already in progress"}, status_code=409)

    @app.exception_handler(DatasetNotFound)
    async def dataset_missing(_request: Request, _exc: DatasetNotFound) -> JSONResponse:
        return JSONResponse({"error": "not found"}, status_code=404)

    @app.exception_handler(StorageError)
    async def storage_failed(_request: Request, _exc: StorageError) -> JSONResponse:
        return JSONResponse(UNAVAILABLE, status_code=503)

    @app.exception_handler(asyncpg.PostgresError)
    async def database_failed(_request: Request, _exc: asyncpg.PostgresError) -> JSONResponse:
        return JSONResponse(UNAVAILABLE, status_code=503)

    @app.exception_handler(asyncpg.InterfaceError)
    async def database_interface_failed(
        _request: Request, _exc: asyncpg.InterfaceError
    ) -> JSONResponse:
        return JSONResponse(UNAVAILABLE, status_code=503)

    @app.exception_handler(OSError)
    async def network_failed(_request: Request, _exc: OSError) -> JSONResponse:
        return JSONResponse(UNAVAILABLE, status_code=503)


def create_app(settings: Settings | None = None) -> FastAPI:
    app = FastAPI(title="QueryPilot API", lifespan=_lifespan)
    app.state.settings = settings
    app.state.pool = None
    app.state.http = None
    app.state.storage = None
    app.include_router(datasets_router, prefix="/api/datasets")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    _register_handlers(app)
    app.add_middleware(UnhandledErrorBoundary)
    return app


app = create_app()
