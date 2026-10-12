"""Date/timestamp parsing with the column-level ambiguity rule
(mirrors lib/ingest/dates.ts):

- yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy, mm/dd/yyyy, dd-Mon-yyyy, dd Mon yyyy
- ambiguous d/m defaults to dd/mm; the COLUMN switches to mm/dd only if some
  value's second part > 12 (detect_date_type)
- timestamps: same date forms + hh:mm[:ss]
- values must be real calendar dates
- detected format strings are returned for storage in date_format
"""

import re
from dataclasses import dataclass
from datetime import date

MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}

_ISO = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})$")
_AMBIG = re.compile(r"^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$")
_MONNAME_SEP = re.compile(r"^(\d{1,2})([/-])([A-Za-z]+)\2(\d{4})$")
_MONNAME_SPACE = re.compile(r"^(\d{1,2}) ([A-Za-z]+) (\d{4})$")
_TIME_SPLIT = re.compile(r"^(.+?)[T ](\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)$")
_TIME = re.compile(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$")


@dataclass(frozen=True)
class ParsedDateTime:
    iso: str  # yyyy-mm-dd or yyyy-mm-ddThh:mm[:ss]
    format: str
    has_time: bool


def _real(y: int, m: int, d: int) -> str | None:
    if not (1000 <= y <= 9999 and 1 <= m <= 12):
        return None
    try:
        return date(y, m, d).isoformat()
    except ValueError:
        return None


def _parse_time(raw: str) -> tuple[str, str] | None:
    m = _TIME.match(raw.strip())
    if not m:
        return None
    h, minute, sec_s = int(m.group(1)), int(m.group(2)), m.group(3)
    if h > 23 or minute > 59:
        return None
    if sec_s is None:
        return f"{h:02d}:{minute:02d}", "hh:mm"
    sec = int(sec_s)
    if sec > 59:
        return None
    return f"{h:02d}:{minute:02d}:{sec:02d}", "hh:mm:ss"


def parse_date_value(raw: str, prefer_mdy: bool = False) -> ParsedDateTime | None:
    s0 = raw.strip()
    if not s0:
        return None

    date_part = s0
    time_part: tuple[str, str] | None = None
    ts = _TIME_SPLIT.match(s0)
    if ts:
        candidate = _parse_time(ts.group(2))
        if candidate is None:
            return None
        date_part, time_part = ts.group(1), candidate
    s = date_part.strip()

    iso: str | None = None
    fmt: str | None = None

    m = _ISO.match(s)
    if m:
        iso = _real(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        fmt = "yyyy-mm-dd"

    if iso is None:
        m = _AMBIG.match(s)
        if m:
            a, b, y = int(m.group(1)), int(m.group(3)), int(m.group(4))
            sep = m.group(2)
            day, month = (b, a) if prefer_mdy else (a, b)
            iso = _real(y, month, day)
            fmt = f"mm{sep}dd{sep}yyyy" if prefer_mdy else f"dd{sep}mm{sep}yyyy"

    if iso is None:
        m = _MONNAME_SEP.match(s)
        sep = None
        if m:
            day_s, mon_s, year_s = m.group(1), m.group(3), m.group(4)
            sep = m.group(2)
        else:
            m = _MONNAME_SPACE.match(s)
            if m:
                day_s, mon_s, year_s = m.group(1), m.group(2), m.group(3)
                sep = " "
        if m and sep is not None:
            month = MONTHS.get(mon_s.lower())
            if month is not None:
                iso = _real(int(year_s), month, int(day_s))
                if iso is not None:
                    fmt = f"dd{sep}Mon{sep}yyyy"

    if iso is None or fmt is None:
        return None
    if time_part is not None:
        return ParsedDateTime(
            iso=f"{iso}T{time_part[0]}", format=f"{fmt} {time_part[1]}", has_time=True
        )
    return ParsedDateTime(iso=iso, format=fmt, has_time=False)


@dataclass(frozen=True)
class DetectedDate:
    type: str  # "date" | "timestamp"
    format: str

    @property
    def prefer_mdy(self) -> bool:
        return self.format.startswith("mm")


def detect_date_type(values: list[str]) -> DetectedDate | None:
    """Column-level detection applying the ambiguity rule:
    default dd/mm; mm/dd only if SOME value's second part > 12."""
    if not values:
        return None

    mdy = False
    for v in values:
        date_part = re.split(r"[T ]", v.strip(), maxsplit=1)[0]
        m = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-]\d{4}$", date_part)
        if m and int(m.group(1)) <= 12 < int(m.group(2)):
            mdy = True
            break

    saw_time = False
    formats: dict[str, int] = {}
    parsed = 0
    for v in values:
        p = parse_date_value(v, mdy)
        if p is None:
            continue
        parsed += 1
        saw_time = saw_time or p.has_time
        formats[p.format] = formats.get(p.format, 0) + 1
    if parsed == 0:
        return None

    best = max(formats.items(), key=lambda kv: kv[1])[0]
    return DetectedDate(type="timestamp" if saw_time else "date", format=best)
