"""Parity eval: the SAME evals/messy-csv corpus and expected.json as the
TypeScript suite. The Python port must hit the same >=90% gate (target: 100%
like the TS implementation)."""

import json
from pathlib import Path

import pytest

from app.ingest.headers import sanitize_headers
from app.ingest.parse import parse_csv
from app.ingest.profile import profile_table

EVALS_DIR = Path(__file__).resolve().parents[2] / "evals" / "messy-csv"


@pytest.fixture(scope="module")
def expected():
    return json.loads((EVALS_DIR / "expected.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def files():
    return sorted(p.name for p in EVALS_DIR.glob("*.csv"))


def test_covers_all_files(files):
    assert len(files) == 10


def _profile_file(name):
    parsed = parse_csv((EVALS_DIR / name).read_bytes())
    return profile_table(sanitize_headers(parsed.headers), parsed.rows)


def test_messy_csv_accuracy(files, expected):
    checked = 0
    correct = 0
    misses: list[str] = []

    for name in files:
        columns = expected[name]
        profile = _profile_file(name)
        assert len(profile.columns) == len(columns), f"{name}: column count mismatch"
        for i, exp in enumerate(columns):
            actual = profile.columns[i]
            checked += 1
            ok = (
                actual.original_header.strip() == exp["original"].strip()
                and actual.column_name == exp["name"]
                and actual.data_type == exp["type"]
            )
            if ok:
                correct += 1
            else:
                misses.append(
                    f"{name} [{exp['original']}]: expected "
                    f"{exp['name']}:{exp['type']}, got "
                    f"{actual.column_name}:{actual.data_type}"
                )

    accuracy = correct / checked if checked else 0.0
    print(f"\n[py-messy-csv] type accuracy: {correct}/{checked} = {accuracy * 100:.1f}%")
    for m in misses:
        print(f"  miss: {m}")
    assert accuracy >= 0.90, f"accuracy {accuracy:.1%} below 90% gate"
