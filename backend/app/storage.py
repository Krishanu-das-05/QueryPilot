import re
from dataclasses import dataclass, field
from urllib.parse import parse_qs, quote, urlsplit
from uuid import UUID

import httpx
from fastapi import HTTPException, Request

from .config import MAX_UPLOAD_BYTES

BUCKET = "uploads"
_UUID_PATTERN = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_NAME_PATTERN = r"[A-Za-z0-9][A-Za-z0-9._-]{0,499}"


class StorageError(Exception):
    pass


class StoredObjectTooLarge(StorageError):
    pass


@dataclass(frozen=True)
class SignedUpload:
    path: str
    token: str = field(repr=False)


def storage_path_is_valid(path: str, dataset_id: UUID | None = None) -> bool:
    prefix = _UUID_PATTERN if dataset_id is None else re.escape(str(dataset_id))
    return ".." not in path and re.fullmatch(rf"{prefix}/{_NAME_PATTERN}", path) is not None


def safe_upload_name(file_name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", file_name)
    return re.sub(r"\.{2,}", "_", cleaned)


def _token_from(payload: object) -> str:
    if not isinstance(payload, dict):
        raise ValueError("unexpected storage response")
    url = payload["url"]
    if not isinstance(url, str):
        raise ValueError("unexpected storage response")
    token = parse_qs(urlsplit(url).query).get("token", [""])[0]
    if not token:
        raise ValueError("missing storage token")
    return token


class SupabaseStorage:
    def __init__(self, client: httpx.AsyncClient, base_url: str, service_key: str) -> None:
        self._client = client
        self._base = base_url.rstrip("/")
        self._service_key = service_key

    def _headers(self) -> dict[str, str]:
        return {
            "apikey": self._service_key,
            "Authorization": f"Bearer {self._service_key}",
        }

    async def create_signed_upload(self, path: str) -> SignedUpload:
        if not storage_path_is_valid(path):
            raise StorageError("invalid storage path")
        url = f"{self._base}/storage/v1/object/upload/sign/{BUCKET}/{quote(path, safe='/')}"
        try:
            response = await self._client.post(url, json={}, headers=self._headers())
            response.raise_for_status()
            token = _token_from(response.json())
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            raise StorageError("could not create upload url") from None
        return SignedUpload(path=path, token=token)

    async def download(self, path: str) -> bytes:
        if not storage_path_is_valid(path):
            raise StorageError("invalid storage path")
        url = f"{self._base}/storage/v1/object/authenticated/{BUCKET}/{quote(path, safe='/')}"
        chunks: list[bytes] = []
        total = 0
        try:
            async with self._client.stream("GET", url, headers=self._headers()) as response:
                if not response.is_success:
                    raise StorageError("could not download uploaded file")
                declared = response.headers.get("content-length")
                if declared is not None and int(declared) > MAX_UPLOAD_BYTES:
                    raise StoredObjectTooLarge("uploaded file exceeds the size limit")
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_UPLOAD_BYTES:
                        raise StoredObjectTooLarge("uploaded file exceeds the size limit")
                    chunks.append(chunk)
        except (httpx.HTTPError, ValueError):
            raise StorageError("could not download uploaded file") from None
        if total == 0:
            raise StorageError("uploaded file is empty")
        return b"".join(chunks)


def get_storage(request: Request) -> SupabaseStorage:
    storage = getattr(request.app.state, "storage", None)
    if storage is None:
        raise HTTPException(status_code=503, detail="service unavailable")
    return storage
