from typing import Any
from uuid import uuid4


def fake_secret() -> str:
    return f"FAKE-KEY-FOR-TESTING-{uuid4().hex}"


class _Transaction:
    def __init__(self, conn: "FakeConnection") -> None:
        self._conn = conn

    async def __aenter__(self) -> "_Transaction":
        self._conn.begin()
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> bool:
        self._conn.end(failed=exc_type is not None)
        return False


class _Acquire:
    def __init__(self, conn: "FakeConnection") -> None:
        self._conn = conn

    async def __aenter__(self) -> "FakeConnection":
        return self._conn

    async def __aexit__(self, *_exc: object) -> bool:
        return False


class FakeConnection:
    def __init__(self, script: dict[str, Any] | None = None) -> None:
        self.script = script or {}
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def begin(self) -> None:
        return None

    def end(self, failed: bool) -> None:
        return None

    def transaction(self) -> _Transaction:
        return _Transaction(self)

    def _answer(self, sql: str, args: tuple[Any, ...]) -> Any:
        self.calls.append((sql, args))
        for needle, answer in self.script.items():
            if needle in sql:
                if isinstance(answer, BaseException):
                    raise answer
                return answer
        raise AssertionError(f"unscripted query: {' '.join(sql.split())[:80]}")

    async def fetchrow(self, sql: str, *args: Any) -> Any:
        return self._answer(sql, args)

    async def fetch(self, sql: str, *args: Any) -> Any:
        return self._answer(sql, args)

    async def fetchval(self, sql: str, *args: Any) -> Any:
        return self._answer(sql, args)

    async def execute(self, sql: str, *args: Any) -> Any:
        return self._answer(sql, args)

    async def executemany(self, sql: str, args: Any) -> Any:
        return self._answer(sql, (args,))


class FakePool:
    def __init__(self, conn: FakeConnection) -> None:
        self.conn = conn

    def acquire(self) -> _Acquire:
        return _Acquire(self.conn)
