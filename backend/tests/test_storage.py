from uuid import UUID, uuid4

import httpx
import pytest

from app.config import MAX_UPLOAD_BYTES
from app.storage import (
    SignedUpload,
    StorageError,
    StoredObjectTooLarge,
    SupabaseStorage,
    safe_upload_name,
    storage_path_is_valid,
)
from tests.doubles import fake_secret

BASE = "https://project.supabase.test"
SERVICE_KEY = fake_secret()
FAKE_TOKEN = fake_secret()
DATASET_ID = "11111111-2222-4333-8444-555555555555"
PATH = f"{DATASET_ID}/abc-data.csv"


class ChunkStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk


@pytest.fixture
async def open_storage():
    clients: list[httpx.AsyncClient] = []

    def build(handler) -> tuple[SupabaseStorage, list[httpx.Request]]:
        seen: list[httpx.Request] = []

        def recording(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return handler(request)

        client = httpx.AsyncClient(
            transport=httpx.MockTransport(recording), timeout=15.0, follow_redirects=False
        )
        clients.append(client)
        return SupabaseStorage(client, BASE, SERVICE_KEY), seen

    yield build
    for client in clients:
        await client.aclose()


async def test_signed_upload_uses_sign_endpoint_and_extracts_token(open_storage):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == f"/storage/v1/object/upload/sign/uploads/{PATH}"
        assert request.headers["apikey"] == SERVICE_KEY
        assert request.headers["authorization"] == f"Bearer {SERVICE_KEY}"
        return httpx.Response(
            200, json={"url": f"/object/upload/sign/uploads/{PATH}?token={FAKE_TOKEN}"}
        )

    storage, seen = open_storage(handler)
    signed = await storage.create_signed_upload(PATH)
    assert signed == SignedUpload(path=PATH, token=FAKE_TOKEN)
    assert len(seen) == 1


def test_signed_upload_repr_does_not_expose_token():
    assert FAKE_TOKEN not in repr(SignedUpload(path=PATH, token=FAKE_TOKEN))


async def test_signed_upload_failure_is_generic(open_storage):
    storage, _ = open_storage(
        lambda request: httpx.Response(500, text=f"{SERVICE_KEY} {request.url}")
    )
    with pytest.raises(StorageError) as excinfo:
        await storage.create_signed_upload(PATH)
    assert SERVICE_KEY not in str(excinfo.value)
    assert "token" not in str(excinfo.value)


@pytest.mark.parametrize(
    "payload",
    [None, [], {}, {"url": 5}, {"url": None}, {"url": f"/object/upload/sign/{PATH}"}],
)
async def test_signed_upload_malformed_payloads_are_generic(open_storage, payload):
    storage, _ = open_storage(lambda request: httpx.Response(200, json=payload))
    with pytest.raises(StorageError):
        await storage.create_signed_upload(PATH)


async def test_signed_upload_malformed_json_is_generic(open_storage):
    storage, _ = open_storage(lambda request: httpx.Response(200, text="not json"))
    with pytest.raises(StorageError):
        await storage.create_signed_upload(PATH)


async def test_signed_upload_redirect_is_not_followed(open_storage):
    storage, seen = open_storage(
        lambda request: httpx.Response(302, headers={"location": "https://evil.test/x"})
    )
    with pytest.raises(StorageError) as excinfo:
        await storage.create_signed_upload(PATH)
    assert "evil.test" not in str(excinfo.value)
    assert len(seen) == 1


async def test_download_streams_bytes_from_authenticated_endpoint(open_storage):
    content = b"id,name\n1,a\n"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == f"/storage/v1/object/authenticated/uploads/{PATH}"
        assert request.headers["authorization"] == f"Bearer {SERVICE_KEY}"
        return httpx.Response(200, content=content)

    storage, _ = open_storage(handler)
    assert await storage.download(PATH) == content


async def test_download_rejects_declared_oversize_before_reading(open_storage):
    storage, _ = open_storage(
        lambda request: httpx.Response(
            200, headers={"content-length": str(MAX_UPLOAD_BYTES + 1)}, content=b"x"
        )
    )
    with pytest.raises(StoredObjectTooLarge):
        await storage.download(PATH)


async def test_download_enforces_limit_while_streaming(open_storage):
    chunks = [b"x" * (1024 * 1024)] * 11
    storage, _ = open_storage(lambda request: httpx.Response(200, stream=ChunkStream(chunks)))
    with pytest.raises(StoredObjectTooLarge):
        await storage.download(PATH)


async def test_download_empty_object_is_generic_error(open_storage):
    storage, _ = open_storage(lambda request: httpx.Response(200, content=b""))
    with pytest.raises(StorageError):
        await storage.download(PATH)


@pytest.mark.parametrize("status", [302, 403, 500])
async def test_download_non_success_is_generic_and_redirects_not_followed(open_storage, status):
    storage, seen = open_storage(
        lambda request: httpx.Response(status, headers={"location": "https://evil.test/x"})
    )
    with pytest.raises(StorageError) as excinfo:
        await storage.download(PATH)
    assert "evil.test" not in str(excinfo.value)
    assert len(seen) == 1


async def test_transport_failure_is_generic_without_secret_text(open_storage):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(SERVICE_KEY)

    storage, _ = open_storage(handler)
    with pytest.raises(StorageError) as excinfo:
        await storage.download(PATH)
    assert SERVICE_KEY not in str(excinfo.value)


@pytest.mark.parametrize(
    "path",
    [
        f"{DATASET_ID}/../escape.csv",
        f"{DATASET_ID}/x..csv",
        f"{DATASET_ID}\\x.csv",
        f"{DATASET_ID}//x.csv",
        f"{DATASET_ID}/a\nb.csv",
        f"{DATASET_ID}/x/y.csv",
        "not-a-uuid/x.csv",
        f"{DATASET_ID}/.hidden.csv",
    ],
)
async def test_invalid_paths_never_reach_the_network(open_storage, path):
    storage, seen = open_storage(lambda request: httpx.Response(200, content=b"x"))
    with pytest.raises(StorageError):
        await storage.download(path)
    with pytest.raises(StorageError):
        await storage.create_signed_upload(path)
    assert seen == []


def test_storage_path_validation_is_scoped_to_dataset_when_asked():
    assert storage_path_is_valid(PATH)
    assert storage_path_is_valid(PATH, dataset_id=UUID(DATASET_ID))
    assert not storage_path_is_valid(PATH, dataset_id=UUID(int=1))


@pytest.mark.parametrize(
    "file_name",
    ["sales..2024.csv", "DATA.CSV", "my file (1).xlsx", "x" * 251 + ".csv", "...hidden.csv"],
)
def test_safe_upload_name_always_satisfies_the_storage_path_validator(file_name):
    path = f"{DATASET_ID}/{uuid4()}-{safe_upload_name(file_name)}"
    assert storage_path_is_valid(path, dataset_id=UUID(DATASET_ID))
