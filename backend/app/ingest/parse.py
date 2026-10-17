"""File parsing: CSV via stdlib csv, XLSX via openpyxl (first sheet only,
dates as ISO). Encoding: UTF-8 with Windows-1252 fallback
(mirrors lib/ingest/parse.ts)."""

import csv
import io
from dataclasses import dataclass
from datetime import date, datetime

import openpyxl

from ..config import MAX_UPLOAD_BYTES

csv.field_size_limit(MAX_UPLOAD_BYTES)


@dataclass
class ParsedFile:
    headers: list[str]
    rows: list[list[str]]


def decode_buffer(buf: bytes) -> str:
    try:
        return buf.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError:
        return buf.decode("cp1252")


def parse_csv(buf: bytes) -> ParsedFile:
    text = decode_buffer(buf)
    reader = csv.reader(io.StringIO(text))
    data = [[(c if c is not None else "") for c in row] for row in reader]
    data = [r for r in data if any(c.strip() for c in r)]
    headers = data[0] if data else []
    return ParsedFile(headers=headers, rows=data[1:])


def _cell_to_string(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, datetime):
        return (
            value.date().isoformat()
            if value.hour == value.minute == value.second == 0
            else value.strftime("%Y-%m-%d %H:%M:%S")
        )
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def parse_xlsx(buf: bytes) -> ParsedFile:
    wb = openpyxl.load_workbook(io.BytesIO(buf), read_only=True, data_only=True)
    all_rows: list[list[str]] = []
    try:
        ws = wb.worksheets[0]
        for row in ws.iter_rows(values_only=True):
            all_rows.append([_cell_to_string(v) for v in row])
    finally:
        wb.close()
    all_rows = [r for r in all_rows if any(c.strip() for c in r)]
    headers = all_rows[0] if all_rows else []
    return ParsedFile(headers=headers, rows=all_rows[1:])


def parse_tabular_file(file_name: str, buf: bytes) -> ParsedFile:
    lower = file_name.lower()
    if lower.endswith(".csv"):
        return parse_csv(buf)
    if lower.endswith(".xlsx"):
        return parse_xlsx(buf)
    raise ValueError(f"unsupported file type: {file_name} (CSV and XLSX only)")
