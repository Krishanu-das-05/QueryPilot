from pathlib import Path

import asyncpg
import pytest

from app import migrate
from app.config import Settings
from app.migrate import (
    CREATE_LEDGER_SQL,
    FAILURE_MESSAGE,
    LEDGER_SQL,
    LOCK_SQL,
    RECORD_SQL,
    MissingEnvironmentVariable,
    apply_migrations,
    render_migration,
    run_migrations,
)
from tests.doubles import fake_secret

CREATE_TABLE_BODY = "CREATE TABLE widgets (id int);"
ROLE_BODY = "ALTER ROLE qp_query PASSWORD :QP_QUERY_PASSWORD;"
DSN = fake_secret()
PASSWORD = fake_secret()


class FakeDatabase:
    def __init__(self, ledger: list[str] | None = None) -> None:
        self.ledger: list[str] = list(ledger or [])
        self.bodies: list[str] = []
        self.queries: list[tuple[str, tuple]] = []
        self.fail_marker: str | None = None


class FakeTransaction:
    def __init__(self, database: FakeDatabase) -> None:
        self._database = database
        self._saved: tuple[list[str], list[str]] = ([], [])

    async def __aenter__(self) -> "FakeTransaction":
        self._saved = (list(self._database.ledger), list(self._database.bodies))
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> bool:
        if exc_type is not None:
            ledger, bodies = self._saved
            self._database.ledger[:] = ledger
            self._database.bodies[:] = bodies
        return False


class FakeConnection:
    def __init__(self, database: FakeDatabase) -> None:
        self.database = database
        self.closed = False

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self.database)

    async def execute(self, query: str, *args: object) -> None:
        self.database.queries.append((query, args))
        if query in (LOCK_SQL, CREATE_LEDGER_SQL):
            return None
        if query == RECORD_SQL:
            self.database.ledger.append(str(args[0]))
            return None
        if self.database.fail_marker and self.database.fail_marker in query:
            raise RuntimeError("injected body failure")
        self.database.bodies.append(query)
        return None

    async def fetch(self, query: str, *args: object) -> list[dict[str, str]]:
        self.database.queries.append((query, args))
        assert query == LEDGER_SQL
        return [{"file_name": name} for name in self.database.ledger]

    async def close(self) -> None:
        self.closed = True


def write_migrations(root: Path, files: dict[str, str]) -> Path:
    directory = root / "migrations"
    directory.mkdir(exist_ok=True)
    for name, body in files.items():
        (directory / name).write_text(body, encoding="utf-8")
    return directory


async def test_lock_is_taken_before_ledger_creation_and_read(tmp_path):
    db = FakeDatabase()
    directory = write_migrations(tmp_path, {"0001_base.sql": CREATE_TABLE_BODY})
    await apply_migrations(FakeConnection(db), directory)
    assert db.queries[:3] == [(LOCK_SQL, (74195001,)), (CREATE_LEDGER_SQL, ()), (LEDGER_SQL, ())]


async def test_pending_files_run_in_lexicographic_order(tmp_path):
    db = FakeDatabase()
    directory = write_migrations(
        tmp_path,
        {
            "0010_c.sql": "SELECT 3;",
            "0002_b.sql": "SELECT 2;",
            "0001_a.sql": "SELECT 1;",
        },
    )
    applied = await apply_migrations(FakeConnection(db), directory)
    assert applied == ["0001_a.sql", "0002_b.sql", "0010_c.sql"]
    assert db.ledger == applied
    assert db.bodies == ["SELECT 1;", "SELECT 2;", "SELECT 3;"]


async def test_invalid_file_name_fails_before_any_sql(tmp_path):
    db = FakeDatabase()
    directory = write_migrations(
        tmp_path, {"0001_ok.sql": "SELECT 1;", "Bad-Name.sql": "SELECT 2;"}
    )
    with pytest.raises(ValueError):
        await apply_migrations(FakeConnection(db), directory)
    assert db.queries == []


async def test_password_placeholder_is_quoted_with_escaped_backslashes(tmp_path):
    db = FakeDatabase()
    directory = write_migrations(tmp_path, {"0002_roles.sql": ROLE_BODY})
    await apply_migrations(FakeConnection(db), directory, "pa\\ss'word")
    assert db.bodies == ["ALTER ROLE qp_query PASSWORD E'pa\\\\ss''word';"]


async def test_password_containing_dollar_tags_never_terminates_the_delimiter(tmp_path):
    db = FakeDatabase()
    body = "DO $$\nBEGIN\n  PERFORM :QP_QUERY_PASSWORD;\nEND\n$$;"
    directory = write_migrations(tmp_path, {"0002_roles.sql": body})
    await apply_migrations(FakeConnection(db), directory, "x$$y$qp_roles_block$z")
    quoted = "E'x$$y$qp_roles_block$z'"
    assert db.bodies == [
        "DO $qp_roles_block_1$\nBEGIN\n  PERFORM " + quoted + ";\nEND\n$qp_roles_block_1$;"
    ]
    assert db.bodies[0].count("$$") == quoted.count("$$")


async def test_missing_password_rolls_back_without_committing_any_ledger_row(tmp_path):
    db = FakeDatabase()
    directory = write_migrations(
        tmp_path, {"0001_base.sql": CREATE_TABLE_BODY, "0002_roles.sql": ROLE_BODY}
    )
    with pytest.raises(ValueError, match="QP_QUERY_PASSWORD"):
        await apply_migrations(FakeConnection(db), directory, None)
    assert db.ledger == []
    assert db.bodies == []


async def test_body_failure_after_first_file_rolls_back_the_whole_run(tmp_path):
    db = FakeDatabase()
    db.fail_marker = "BOOM"
    directory = write_migrations(
        tmp_path, {"0001_base.sql": CREATE_TABLE_BODY, "0002_boom.sql": "BOOM;"}
    )
    with pytest.raises(RuntimeError, match="injected body failure"):
        await apply_migrations(FakeConnection(db), directory)
    assert db.ledger == []
    assert db.bodies == []
    assert (CREATE_TABLE_BODY, ()) in db.queries


async def test_rerun_applies_only_remaining_files_once(tmp_path):
    db = FakeDatabase()
    directory = write_migrations(tmp_path, {"0001_base.sql": CREATE_TABLE_BODY})
    assert await apply_migrations(FakeConnection(db), directory) == ["0001_base.sql"]
    (directory / "0002_more.sql").write_text("SELECT 2;", encoding="utf-8")
    assert await apply_migrations(FakeConnection(db), directory) == ["0002_more.sql"]
    assert await apply_migrations(FakeConnection(db), directory) == []
    assert db.ledger == ["0001_base.sql", "0002_more.sql"]
    assert len(db.bodies) == 2


async def test_already_applied_files_are_skipped_without_password(tmp_path):
    db = FakeDatabase(ledger=["0002_roles.sql"])
    directory = write_migrations(tmp_path, {"0002_roles.sql": ROLE_BODY})
    assert await apply_migrations(FakeConnection(db), directory, None) == []
    assert db.bodies == []


async def test_run_migrations_connects_with_pooler_safe_options_and_closes_on_error(tmp_path):
    db = FakeDatabase()
    db.fail_marker = "BOOM"
    directory = write_migrations(tmp_path, {"0001_boom.sql": "BOOM;"})
    seen: dict = {}

    async def connect(**kwargs):
        seen.update(kwargs)
        seen["conn"] = FakeConnection(db)
        return seen["conn"]

    with pytest.raises(RuntimeError):
        await run_migrations(DSN, PASSWORD, migrations_dir=directory, connect=connect)
    assert seen["dsn"] == DSN
    assert {k: seen[k] for k in ("statement_cache_size", "command_timeout")} == {
        "statement_cache_size": 0,
        "command_timeout": 30,
    }
    assert seen["conn"].closed


def test_cli_success_prints_only_applied_filenames(monkeypatch, capsys):
    monkeypatch.setattr(
        migrate,
        "settings_from_startup",
        lambda: Settings(database_url_admin=DSN, qp_query_password=PASSWORD),
    )

    async def fake_run(dsn, qp_query_password):
        assert dsn == DSN
        assert qp_query_password == PASSWORD
        return ["0001_base.sql"]

    monkeypatch.setattr(migrate, "run_migrations", fake_run)
    assert migrate.main() == 0
    captured = capsys.readouterr()
    assert captured.out == "applied 0001_base.sql\n1 migration(s) applied\n"
    assert captured.err == ""


def test_cli_failure_prints_fixed_message_without_secrets(monkeypatch, capsys):
    monkeypatch.setattr(
        migrate,
        "settings_from_startup",
        lambda: Settings(database_url_admin=DSN, qp_query_password=PASSWORD),
    )

    async def broken_connect(**kwargs):
        raise OSError(f"could not reach {kwargs['dsn']} with {PASSWORD}")

    monkeypatch.setattr(asyncpg, "connect", broken_connect)
    assert migrate.main() == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == FAILURE_MESSAGE + "\n"
    assert DSN not in captured.err
    assert PASSWORD not in captured.err


def test_cli_names_only_the_missing_dsn_variable(monkeypatch, capsys):
    monkeypatch.setattr(migrate, "settings_from_startup", lambda: Settings())
    assert migrate.main() == 1
    captured = capsys.readouterr()
    assert captured.err == "Missing required environment variable: DATABASE_URL_ADMIN\n"
    assert captured.out == ""


def test_missing_variable_error_is_a_value_error_with_fixed_name():
    error = MissingEnvironmentVariable("QP_QUERY_PASSWORD")
    assert isinstance(error, ValueError)
    assert error.name == "QP_QUERY_PASSWORD"
    with pytest.raises(MissingEnvironmentVariable) as excinfo:
        render_migration(ROLE_BODY, None)
    assert excinfo.value.name == "QP_QUERY_PASSWORD"


def test_cli_names_only_the_missing_password_variable(monkeypatch, capsys):
    monkeypatch.setattr(migrate, "settings_from_startup", lambda: Settings(database_url_admin=DSN))

    async def needs_password(dsn, qp_query_password):
        raise MissingEnvironmentVariable("QP_QUERY_PASSWORD")

    monkeypatch.setattr(migrate, "run_migrations", needs_password)
    assert migrate.main() == 1
    captured = capsys.readouterr()
    assert captured.err == "Missing required environment variable: QP_QUERY_PASSWORD\n"
    assert captured.out == ""
    assert DSN not in captured.err


def test_cli_config_load_failure_is_generic_without_traceback(monkeypatch, capsys):
    def broken_startup():
        raise RuntimeError(PASSWORD)

    monkeypatch.setattr(migrate, "settings_from_startup", broken_startup)
    assert migrate.main() == 1
    captured = capsys.readouterr()
    assert captured.err == FAILURE_MESSAGE + "\n"
    assert captured.out == ""
    assert PASSWORD not in captured.err
    assert "Traceback" not in captured.err


def test_real_role_template_keeps_password_marker_comment_unmodified():
    body = (migrate.MIGRATIONS_DIR / "0002_roles.sql").read_text(encoding="utf-8")
    value = fake_secret() + "'\\\n\r\t$$$qp_roles_block$"
    rendered = migrate.render_migration(body, value)
    before = [line for line in body.splitlines() if line.startswith("--")]
    after = [line for line in rendered.splitlines() if line.startswith("--")]
    assert after == before
    assert sum(migrate.SUBSTITUTION_MARKER in line for line in after) == 1
    assert rendered.count("PASSWORD E'") == 2
    assert "\r" not in rendered
    assert r"\n\r\t" in rendered
    assert rendered.count("$qp_roles_block_1$") == 2


@pytest.mark.parametrize(
    "body",
    [
        "-- :QP_QUERY_PASSWORD\nSELECT 1;",
        "-- :QP_QUERY_PASSWORD\rSELECT 1;",
        "/* nested /* :QP_QUERY_PASSWORD */ comment */ SELECT 1;",
        "SELECT ':QP_QUERY_PASSWORD';",
        'SELECT ":QP_QUERY_PASSWORD";',
        r"SELECT E'escaped\':QP_QUERY_PASSWORD';",
    ],
)
def test_nonexecutable_markers_do_not_need_or_receive_a_password(body):
    assert migrate.render_migration(body, None) == body
    assert migrate.render_migration(body, PASSWORD) == body


def test_quoted_and_comment_markers_remain_while_executable_marker_is_replaced():
    body = "SELECT ':QP_QUERY_PASSWORD'; /* :QP_QUERY_PASSWORD */ " + ROLE_BODY
    rendered = migrate.render_migration(body, PASSWORD)
    assert rendered.startswith("SELECT ':QP_QUERY_PASSWORD'; /* :QP_QUERY_PASSWORD */ ")
    assert rendered.endswith(f"ALTER ROLE qp_query PASSWORD E'{PASSWORD}';")


def test_dollar_tag_avoids_existing_source_content():
    body = "DO $$ BEGIN PERFORM '$qp_roles_block$'; PERFORM :QP_QUERY_PASSWORD; END $$;"
    rendered = migrate.render_migration(body, PASSWORD)
    assert rendered.startswith("DO $qp_roles_block_1$")
    assert rendered.endswith("END $qp_roles_block_1$;")
    assert "PERFORM '$qp_roles_block$'" in rendered


@pytest.mark.parametrize("body", ["/* unclosed", "SELECT 'unclosed", 'SELECT "unclosed'])
def test_malformed_templates_fail_without_credentials_in_error(body):
    with pytest.raises(ValueError, match="invalid migration template") as excinfo:
        migrate.render_migration(body, PASSWORD)
    assert PASSWORD not in str(excinfo.value)


def test_nul_in_credential_is_rejected_without_echoing_it():
    value = fake_secret() + "\x00"
    with pytest.raises(ValueError, match="invalid migration credential") as excinfo:
        migrate.render_migration(ROLE_BODY, value)
    assert value not in str(excinfo.value)
