import copy
import io
import json
import zipfile
from dataclasses import replace
from uuid import UUID, uuid4

import pytest

from app.ingest import pipeline
from app.ingest.describe import DescribeInput, TableDescription
from app.ingest.headers import sanitize_headers
from app.ingest.pipeline import (
    PROCESSING_FAILED_MESSAGE,
    CatalogTableRow,
    DatasetRow,
    FileRow,
    IngestBusy,
    IngestDataError,
    deserialize_profile,
    run_ingest_step,
    serialize_profile,
)
from app.ingest.profile import profile_table
from app.ingest.tablename import table_name_for_file
from tests.doubles import FakeConnection, FakePool

DATASET = UUID("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
SCHEMA = "ds_aaaaaaaa"
ROLE = "ds_aaaaaaaa_r"
STORED_PROFILE_KEYS = {
    "ordinal",
    "columnName",
    "originalHeader",
    "dataType",
    "dateFormat",
    "isPercent",
    "isCandidateKey",
    "rowCount",
    "nullCount",
    "nullPct",
    "distinctCount",
    "coercedCount",
    "minValue",
    "maxValue",
    "topValues",
    "sampleValues",
    "distinctValues",
}


def csv_ids(count: int) -> bytes:
    return ("id\n" + "\n".join(str(i) for i in range(1, count + 1)) + "\n").encode()


class MemoryDatabase:
    def __init__(self) -> None:
        self.state: dict = {
            "datasets": {},
            "file_owner": {},
            "files": {},
            "table_ids": {},
            "tables": {},
            "columns": {},
            "relationships": {},
            "errors": {},
            "rows": {},
            "schemas": set(),
            "roles": set(),
            "grants": [],
            "indexes": [],
            "analyzed": [],
            "batch_sizes": [],
            "searched": [],
        }
        self.busy: set[UUID] = set()


class MemoryConnection(FakeConnection):
    def __init__(self, database: MemoryDatabase) -> None:
        super().__init__()
        self.database = database
        self._snapshots: list[dict] = []

    def begin(self) -> None:
        self._snapshots.append(copy.deepcopy(self.database.state))

    def end(self, failed: bool) -> None:
        snapshot = self._snapshots.pop()
        if failed:
            self.database.state = snapshot


class MemoryStore:
    def __init__(self, conn: MemoryConnection) -> None:
        self._db = conn.database

    @property
    def _s(self) -> dict:
        return self._db.state

    async def lock_dataset(self, dataset_id: UUID) -> DatasetRow | None:
        if dataset_id in self._db.busy:
            raise IngestBusy
        return self._s["datasets"].get(dataset_id)

    async def list_files(self, dataset_id: UUID) -> list[FileRow]:
        files = [
            f for fid, f in self._s["files"].items() if self._s["file_owner"][fid] == dataset_id
        ]
        return sorted(files, key=lambda f: (f.original_name, str(f.id)))

    async def save_profile(self, file_id: UUID, profile: dict, row_count: int) -> None:
        self._s["files"][file_id] = replace(
            self._s["files"][file_id], profile=json.loads(json.dumps(profile)), row_count=row_count
        )

    async def set_rows_loaded(self, file_id: UUID, rows_loaded: int) -> None:
        self._s["files"][file_id] = replace(self._s["files"][file_id], rows_loaded=rows_loaded)

    async def set_status(self, dataset_id: UUID, status: str) -> None:
        self._s["datasets"][dataset_id] = replace(self._s["datasets"][dataset_id], status=status)

    async def mark_failed(self, dataset_id: UUID, message: str) -> None:
        self._s["datasets"][dataset_id] = replace(self._s["datasets"][dataset_id], status="failed")
        self._s["errors"][dataset_id] = message

    async def set_loading(self, dataset_id: UUID, schema: str, role: str) -> None:
        self._s["datasets"][dataset_id] = replace(
            self._s["datasets"][dataset_id], status="loading", schema_name=schema, role_name=role
        )

    async def insert_catalog(self, dataset_id, tables, relationships) -> None:
        for file, profile in tables:
            table_id = uuid4()
            row = CatalogTableRow(id=table_id, table_name=file.table_name, description=None)
            self._s["tables"][table_id] = row
            self._s["table_ids"].setdefault(dataset_id, []).append(table_id)
            self._s["columns"][table_id] = [
                {
                    "ordinal": c.ordinal,
                    "column_name": c.column_name,
                    "original_header": c.original_header,
                    "data_type": c.data_type,
                    "date_format": c.date_format,
                    "is_percent": c.is_percent,
                    "is_candidate_key": c.is_candidate_key,
                    "null_pct": c.null_pct,
                    "distinct_count": c.distinct_count,
                    "min_value": c.min_value,
                    "max_value": c.max_value,
                    "top_values": c.top_values,
                    "sample_values": c.sample_values,
                    "description": None,
                }
                for c in profile.columns
            ]
        self._s["relationships"].setdefault(dataset_id, []).extend(relationships or [])

    async def catalog_columns_by_table(self, dataset_id: UUID) -> list:
        grouped = []
        for table in await self.catalog_tables(dataset_id):
            columns = self._s["columns"][table.id]
            grouped.append(
                (table.table_name, [(c["column_name"], c["data_type"]) for c in columns])
            )
        return grouped

    async def ensure_loading_infra(self, schema, role, tables) -> None:
        self._s["schemas"].add(schema)
        self._s["roles"].add(role)
        for table_name, columns in tables:
            if columns:
                self._s["rows"].setdefault((schema, table_name), [])

    async def grant_select(self, schema: str, role: str) -> None:
        self._s["grants"].append((schema, role))

    async def index_targets(self, dataset_id: UUID) -> list[tuple[str, str]]:
        targets = []
        for table in await self.catalog_tables(dataset_id):
            for column in self._s["columns"][table.id]:
                if column["is_candidate_key"]:
                    targets.append((table.table_name, column["column_name"]))
        for rel in self._s["relationships"].get(dataset_id, []):
            targets.append((rel.from_table, rel.from_column))
        return targets

    async def create_index(self, schema: str, table: str, column: str, name: str) -> None:
        self._s["indexes"].append((schema, table, column, name))

    async def analyze(self, schema: str, table: str) -> None:
        self._s["analyzed"].append((schema, table))

    async def insert_rows(self, schema, table, columns, pg_types, rows) -> None:
        assert len(columns) == len(pg_types)
        assert len(rows) <= pipeline.INSERT_BATCH
        self._s["rows"].setdefault((schema, table), []).extend(rows)
        self._s["batch_sizes"].append(len(rows))

    async def catalog_tables(self, dataset_id: UUID) -> list[CatalogTableRow]:
        tables = [self._s["tables"][i] for i in self._s["table_ids"].get(dataset_id, [])]
        return sorted(tables, key=lambda t: t.table_name)

    async def catalog_columns(self, table_id: UUID) -> list[dict]:
        return sorted((dict(c) for c in self._s["columns"][table_id]), key=lambda c: c["ordinal"])

    async def sample_rows(self, schema: str, table: str, columns: list[str]) -> list[list[str]]:
        rows = self._s["rows"].get((schema, table), [])[:5]
        return [["" if v is None else str(v) for v in row] for row in rows]

    async def set_table_description(self, table_id: UUID, description: str) -> None:
        self._s["tables"][table_id] = replace(self._s["tables"][table_id], description=description)

    async def set_column_description(
        self, table_id: UUID, column_name: str, description: str
    ) -> None:
        for column in self._s["columns"][table_id]:
            if column["column_name"] == column_name:
                column["description"] = description

    async def finish_search(self, dataset_id: UUID) -> None:
        self._s["searched"].append(dataset_id)


@pytest.fixture(autouse=True)
def memory_store(monkeypatch):
    monkeypatch.setattr(pipeline, "PgIngestStore", MemoryStore)


def seed(database: MemoryDatabase, dataset_id: UUID, files: dict[str, bytes]) -> dict[str, bytes]:
    state = database.state
    state["datasets"][dataset_id] = DatasetRow(
        id=dataset_id, status="uploaded", schema_name=None, role_name=None
    )
    contents: dict[str, bytes] = {}
    taken: set[str] = set()
    for name, content in files.items():
        file_id = uuid4()
        path = f"{dataset_id}/{file_id}-{name}"
        table_name = table_name_for_file(name, taken)
        taken.add(table_name)
        state["files"][file_id] = FileRow(
            id=file_id,
            storage_path=path,
            original_name=name,
            table_name=table_name,
            row_count=None,
            rows_loaded=0,
            profile=None,
        )
        state["file_owner"][file_id] = dataset_id
        contents[path] = content
    return contents


async def no_description(data: DescribeInput) -> None:
    return None


def make_get_content(contents: dict[str, bytes]):
    async def fetch(file: FileRow) -> bytes:
        return contents[file.storage_path]

    return fetch


async def step(database, dataset_id, contents, *, describe=no_description, after_batch=None):
    return await run_ingest_step(
        dataset_id,
        FakePool(MemoryConnection(database)),
        get_content=make_get_content(contents),
        describe=describe,
        after_batch=after_batch,
    )


async def run_steps(database, dataset_id, contents, *, describe=no_description, max_steps=100):
    results = []
    for _ in range(max_steps):
        result = await step(database, dataset_id, contents, describe=describe)
        results.append(result)
        if result["status"] in ("ready", "failed"):
            break
    return results


async def test_full_lifecycle_reaches_ready_with_expected_transitions():
    db = MemoryDatabase()
    contents = seed(
        db,
        DATASET,
        {"a.csv": b"id,name\n1,x\n2,y\n3,z\n", "b.csv": b"id,val\n10,1\n11,2\n12,3\n"},
    )
    results = await run_steps(db, DATASET, contents)
    assert results == [
        {"status": "profiling", "progress": 50},
        {"status": "profiling", "progress": 100},
        {"status": "loading", "progress": 0},
        {"status": "loading", "progress": 50},
        {"status": "loading", "progress": 100},
        {"status": "describing", "progress": 100},
        {"status": "describing", "progress": 50},
        {"status": "describing", "progress": 100},
        {"status": "ready", "progress": 100},
    ]
    dataset = db.state["datasets"][DATASET]
    assert (dataset.schema_name, dataset.role_name) == (SCHEMA, ROLE)
    assert (SCHEMA, ROLE) in db.state["grants"]
    assert (SCHEMA, "a", "id", "ix_a_id") in db.state["indexes"]
    assert sum(db.state["batch_sizes"]) == 6
    assert db.state["searched"] == [DATASET]


async def test_loading_is_bounded_to_rows_per_step_and_batches_of_insert_batch():
    db = MemoryDatabase()
    contents = seed(db, DATASET, {"big.csv": csv_ids(25000)})
    first = await run_steps(db, DATASET, contents, max_steps=3)
    assert first[-1] == {"status": "loading", "progress": 80}
    assert db.state["batch_sizes"] == [1000] * 20
    assert db.state["files"][next(iter(db.state["files"]))].rows_loaded == 20000

    second = await run_steps(db, DATASET, contents, max_steps=1)
    assert second == [{"status": "loading", "progress": 100}]
    assert db.state["batch_sizes"] == [1000] * 20 + [1000] * 5
    assert len(db.state["rows"][(SCHEMA, "big")]) == 25000


async def test_failure_after_first_batch_rolls_back_rows_and_cursor():
    db = MemoryDatabase()
    contents = seed(db, DATASET, {"big.csv": csv_ids(25000)})
    await run_steps(db, DATASET, contents, max_steps=2)
    file_id = next(iter(db.state["files"]))

    async def fail_after_first_batch(batch_index: int) -> None:
        if batch_index == 0:
            raise RuntimeError("injected failure")

    with pytest.raises(RuntimeError, match="injected failure"):
        await step(db, DATASET, contents, after_batch=fail_after_first_batch)
    assert db.state["files"][file_id].rows_loaded == 0
    assert db.state["rows"].get((SCHEMA, "big"), []) == []
    assert db.state["batch_sizes"] == []
    assert db.state["datasets"][DATASET].status == "loading"

    retry = await step(db, DATASET, contents)
    assert retry == {"status": "loading", "progress": 80}
    assert db.state["files"][file_id].rows_loaded == 20000
    assert len(db.state["rows"][(SCHEMA, "big")]) == 20000


async def test_stored_profile_roundtrips_in_ts_camel_shape():
    headers = sanitize_headers(["Order ID", "Amount"])
    profile = profile_table(headers, [["1", "$1,000"], ["2", "5%"]])
    stored = serialize_profile(profile)
    assert set(stored) == {"rowCount", "columns"}
    assert set(stored["columns"][0]) == STORED_PROFILE_KEYS
    assert deserialize_profile(json.loads(json.dumps(stored))) == profile


async def test_terminal_states_do_not_change_state():
    db = MemoryDatabase()
    contents = seed(db, DATASET, {"a.csv": b"id\n1\n2\n"})
    await run_steps(db, DATASET, contents)
    before = copy.deepcopy(db.state)
    assert await step(db, DATASET, contents) == {"status": "ready", "progress": 100}
    assert db.state == before

    failed = uuid4()
    failed_contents = seed(db, failed, {"empty.csv": b""})
    await run_steps(db, failed, failed_contents)
    assert await step(db, failed, failed_contents) == {"status": "failed", "progress": 0}


async def test_busy_dataset_is_rejected_while_independent_dataset_proceeds():
    db = MemoryDatabase()
    other = uuid4()
    contents = seed(db, DATASET, {"a.csv": b"id\n1\n"})
    contents.update(seed(db, other, {"b.csv": b"id\n1\n"}))
    db.busy.add(DATASET)
    with pytest.raises(IngestBusy):
        await step(db, DATASET, contents)
    assert db.state["datasets"][DATASET].status == "uploaded"
    assert await step(db, other, contents) == {"status": "profiling", "progress": 100}


@pytest.mark.parametrize(
    "name,content",
    [("empty.csv", b""), ("notes.json", b"{}"), ("headers.csv", b"\n\n")],
)
async def test_deterministic_bad_upload_fails_terminally_with_fixed_message(name, content):
    db = MemoryDatabase()
    contents = seed(db, DATASET, {name: content})
    results = await run_steps(db, DATASET, contents)
    assert results[-1] == {"status": "failed", "progress": 0}
    assert db.state["datasets"][DATASET].status == "failed"
    assert db.state["errors"][DATASET] == PROCESSING_FAILED_MESSAGE


async def test_dataset_without_files_fails():
    db = MemoryDatabase()
    db.state["datasets"][DATASET] = DatasetRow(
        id=DATASET, status="uploaded", schema_name=None, role_name=None
    )
    assert await step(db, DATASET, {}) == {"status": "failed", "progress": 0}
    assert db.state["errors"][DATASET] == PROCESSING_FAILED_MESSAGE


async def test_description_failure_still_completes_as_ready():
    db = MemoryDatabase()
    contents = seed(db, DATASET, {"a.csv": b"id,name\n1,x\n2,y\n"})

    async def broken(data: DescribeInput) -> None:
        raise RuntimeError("injected describe failure")

    results = await run_steps(db, DATASET, contents, describe=broken)
    assert results[-1] == {"status": "ready", "progress": 100}
    assert [t.description for t in db.state["tables"].values()] == [""]


async def test_description_writes_only_known_columns_and_table_sentinel():
    db = MemoryDatabase()
    contents = seed(db, DATASET, {"a.csv": b"id,name\n1,x\n2,y\n"})
    seen: list[DescribeInput] = []

    async def describe(data: DescribeInput) -> TableDescription:
        seen.append(data)
        return TableDescription(
            table_description="Orders",
            columns={"id": "Order id", "ghost": "not a column"},
        )

    await run_steps(db, DATASET, contents, describe=describe)
    (table,) = db.state["tables"].values()
    assert table.description == "Orders"
    descriptions = {c["column_name"]: c["description"] for c in db.state["columns"][table.id]}
    assert descriptions == {"id": "Order id", "name": None}
    assert seen[0].table_name == "a"
    assert seen[0].columns[0]["columnName"] == "id"


def zip_bytes(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return buffer.getvalue()


@pytest.mark.parametrize(
    "content",
    [
        b"PK\x03\x04 not a workbook",
        zip_bytes({}),
        zip_bytes({"[Content_Types].xml": b"<Types/>"}),
        zip_bytes(
            {
                "[Content_Types].xml": b"<<bad",
                "xl/workbook.xml": b"<<bad",
                "_rels/.rels": b"<<bad",
            }
        ),
    ],
    ids=["not-zip", "zip-without-parts", "zip-without-workbook", "zip-with-bad-xml"],
)
async def test_malformed_xlsx_fails_terminally_with_fixed_message(content):
    db = MemoryDatabase()
    contents = seed(db, DATASET, {"broken.xlsx": content})
    results = await run_steps(db, DATASET, contents)
    assert results[-1] == {"status": "failed", "progress": 0}
    assert db.state["errors"][DATASET] == PROCESSING_FAILED_MESSAGE


async def test_parser_defect_propagates_and_does_not_mark_dataset_failed(monkeypatch):
    db = MemoryDatabase()
    contents = seed(db, DATASET, {"a.csv": b"id\n1\n"})

    def broken_parser(original_name, content):
        raise RuntimeError("parser defect")

    monkeypatch.setattr(pipeline, "parse_tabular_file", broken_parser)
    with pytest.raises(RuntimeError, match="parser defect"):
        await step(db, DATASET, contents)
    assert db.state["datasets"][DATASET].status == "uploaded"
    assert DATASET not in db.state["errors"]


async def test_malformed_persisted_profile_fails_terminally():
    db = MemoryDatabase()
    contents = seed(db, DATASET, {"a.csv": b"id\n1\n2\n"})
    await step(db, DATASET, contents)
    (file_id,) = db.state["files"]
    db.state["files"][file_id] = replace(
        db.state["files"][file_id], profile={"rowCount": "two", "columns": []}
    )
    results = await run_steps(db, DATASET, contents)
    assert results[-1] == {"status": "failed", "progress": 0}
    assert db.state["errors"][DATASET] == PROCESSING_FAILED_MESSAGE


def valid_stored_profile() -> dict:
    return serialize_profile(profile_table(sanitize_headers(["id"]), [["1"], ["2"]]))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda raw: [],
        lambda raw: {**raw, "rowCount": "2"},
        lambda raw: {**raw, "columns": [{**raw["columns"][0], "dataType": "uuid"}]},
        lambda raw: {**raw, "columns": [raw["columns"][0], raw["columns"][0]]},
        lambda raw: {**raw, "columns": [{**raw["columns"][0], "distinctCount": -1}]},
        lambda raw: {**raw, "columns": [{**raw["columns"][0], "nullPct": 150.0}]},
        lambda raw: {**raw, "columns": [{**raw["columns"][0], "columnName": "Bad Name"}]},
        lambda raw: {
            **raw,
            "columns": [{k: v for k, v in raw["columns"][0].items() if k != "ordinal"}],
        },
    ],
)
def test_malformed_persisted_profiles_fail_without_chained_detail(mutate):
    with pytest.raises(IngestDataError) as excinfo:
        deserialize_profile(mutate(valid_stored_profile()))
    assert str(excinfo.value) == PROCESSING_FAILED_MESSAGE
    assert excinfo.value.__cause__ is None
    assert excinfo.value.__suppress_context__


def test_index_names_are_bounded_and_collision_free():
    used: set[str] = set()
    names = [
        pipeline._index_name("t" * 63, "c" * 63, used),
        pipeline._index_name("t" * 63, "other", used),
        pipeline._index_name("a_b", "c", used),
        pipeline._index_name("a", "b_c", used),
    ]
    assert all(len(name) <= 63 for name in names)
    assert len(set(names)) == len(names)
