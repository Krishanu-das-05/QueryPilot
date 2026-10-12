import pytest

from app.ingest.dates import detect_date_type, parse_date_value
from app.ingest.nulls import is_null_token
from app.ingest.numbers import parse_number


class TestNullTokens:
    @pytest.mark.parametrize(
        "t", ["", "-", "--", "na", "n/a", "null", "none", "nil", "#n/a", " NA ", "N/A"]
    )
    def test_junk_tokens(self, t):
        assert is_null_token(t)

    def test_none_is_null(self):
        assert is_null_token(None)

    @pytest.mark.parametrize("t", ["0", "-5", "navy", "numbers", "nulla"])
    def test_real_values(self, t):
        assert not is_null_token(t)


class TestParseNumber:
    def test_currency(self):
        assert parse_number("₹1,00,000").value == 100000
        assert parse_number("Rs. 2,50,000").value == 250000
        assert parse_number("INR 75,000").value == 75000
        assert parse_number("$1,234.56").value == 1234.56

    def test_indian_grouping(self):
        assert parse_number("1,00,000").value == 100000
        assert parse_number("12,34,567").value == 1234567

    def test_parentheses_negative(self):
        p = parse_number("(1,200)")
        assert (p.value, p.is_integer) == (-1200, True)

    def test_percent(self):
        p = parse_number("12%")
        assert (p.value, p.is_percent) == (pytest.approx(0.12), True)
        assert parse_number("50%").value == 0.5

    def test_rejects(self):
        assert parse_number("abc") is None
        assert parse_number("12x") is None
        assert parse_number("2024-01-01") is None
        assert parse_number("9" * 400) is None


class TestDates:
    def test_iso(self):
        assert parse_date_value("2024-03-15").iso == "2024-03-15"

    def test_ambiguous_defaults_ddmm(self):
        assert parse_date_value("05/01/2024").iso == "2024-01-05"
        assert parse_date_value("05-01-2024").format == "dd-mm-yyyy"

    def test_mdy_override(self):
        assert parse_date_value("01/05/2024", True).iso == "2024-01-05"
        assert parse_date_value("12/25/2024", True).format == "mm/dd/yyyy"

    def test_month_names(self):
        assert parse_date_value("22-Jan-2024").iso == "2024-01-22"
        assert parse_date_value("4 March 2024").iso == "2024-03-04"

    def test_timestamps(self):
        p = parse_date_value("2024-01-15 09:30:00")
        assert p.has_time and p.iso == "2024-01-15T09:30:00"

    def test_impossible_dates(self):
        assert parse_date_value("31/02/2024") is None
        assert parse_date_value("2024-13-01") is None

    def test_ambiguity_rule(self):
        d = detect_date_type(["05/01/2024", "06/02/2024"])
        assert d.format == "dd/mm/yyyy"
        d2 = detect_date_type(["01/13/2024", "05/06/2024"])
        assert d2.format == "mm/dd/yyyy"
        assert detect_date_type(["2024-01-15 09:30:00"]).type == "timestamp"
