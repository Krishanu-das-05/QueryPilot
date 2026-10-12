import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_FILES_PER_DATASET = 5
ALLOWED_UPLOAD_EXTENSIONS = (".csv", ".xlsx")


@dataclass(frozen=True)
class Settings:
    database_url_admin: str | None = field(default=None, repr=False)
    database_url_query: str | None = field(default=None, repr=False)
    qp_query_password: str | None = field(default=None, repr=False)
    supabase_url: str | None = field(default=None, repr=False)
    supabase_service_role_key: str | None = field(default=None, repr=False)
    upload_passphrase: str | None = field(default=None, repr=False)
    openrouter_api_key: str | None = field(default=None, repr=False)
    openrouter_model: str | None = None
    openrouter_fallback_model: str | None = None

    @classmethod
    def from_env(cls, environ: Mapping[str, str] = os.environ) -> "Settings":
        def value(name: str) -> str | None:
            return environ.get(name) or None

        return cls(
            database_url_admin=value("DATABASE_URL_ADMIN"),
            database_url_query=value("DATABASE_URL_QUERY"),
            qp_query_password=value("QP_QUERY_PASSWORD"),
            supabase_url=value("NEXT_PUBLIC_SUPABASE_URL"),
            supabase_service_role_key=value("SUPABASE_SERVICE_ROLE_KEY"),
            upload_passphrase=value("UPLOAD_PASSPHRASE"),
            openrouter_api_key=value("OPENROUTER_API_KEY"),
            openrouter_model=value("OPENROUTER_MODEL"),
            openrouter_fallback_model=value("OPENROUTER_FALLBACK_MODEL"),
        )


def settings_from_startup() -> Settings:
    load_dotenv(REPO_ROOT / ".env.local", override=False)
    return Settings.from_env()
