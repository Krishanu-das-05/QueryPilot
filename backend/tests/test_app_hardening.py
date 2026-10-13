import httpx
import pytest

from app import main as main_module
from app.config import Settings
from tests.doubles import fake_secret


class ClosingPool:
    def __init__(self, close_error: BaseException | None = None) -> None:
        self.closed = False
        self._close_error = close_error

    async def close(self) -> None:
        self.closed = True
        if self._close_error is not None:
            raise self._close_error


def tracking_http_clients(monkeypatch) -> list[httpx.AsyncClient]:
    created: list[httpx.AsyncClient] = []

    class TrackingClient(httpx.AsyncClient):
        def __init__(self, *args, **kwargs) -> None:
            super().__init__(*args, **kwargs)
            created.append(self)

    monkeypatch.setattr(main_module.httpx, "AsyncClient", TrackingClient)
    return created


async def test_query_pool_startup_failure_still_closes_admin_pool_and_http_client(monkeypatch):
    created = tracking_http_clients(monkeypatch)
    admin = ClosingPool()

    async def fake_admin(dsn: str) -> ClosingPool:
        return admin

    async def broken_query(dsn: str):
        raise OSError(fake_secret())

    monkeypatch.setattr(main_module, "create_admin_pool", fake_admin)
    monkeypatch.setattr(main_module, "create_query_pool", broken_query)
    app = main_module.create_app(
        Settings(database_url_admin=fake_secret(), database_url_query=fake_secret())
    )
    with pytest.raises(OSError):
        async with app.router.lifespan_context(app):
            pass
    assert admin.closed
    assert created[0].is_closed


async def test_query_pool_close_failure_still_closes_admin_pool_and_http_client(monkeypatch):
    created = tracking_http_clients(monkeypatch)
    admin = ClosingPool()
    query = ClosingPool(close_error=RuntimeError("close failed"))

    async def fake_admin(dsn: str) -> ClosingPool:
        return admin

    async def fake_query(dsn: str) -> ClosingPool:
        return query

    monkeypatch.setattr(main_module, "create_admin_pool", fake_admin)
    monkeypatch.setattr(main_module, "create_query_pool", fake_query)
    app = main_module.create_app(
        Settings(database_url_admin=fake_secret(), database_url_query=fake_secret())
    )
    with pytest.raises(RuntimeError, match="close failed"):
        async with app.router.lifespan_context(app):
            pass
    assert query.closed
    assert admin.closed
    assert created[0].is_closed
