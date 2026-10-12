from app.ingest.headers import sanitize_headers


def names(out):
    return [h["name"] for h in out]


def test_snake_case_and_symbols():
    out = sanitize_headers(["Order ID", "Sales ($)", "Ship-Date!"])
    assert names(out) == ["order_id", "sales", "ship_date"]
    assert out[0]["original"] == "Order ID"


def test_digit_prefix():
    assert sanitize_headers(["2024 Revenue"])[0]["name"] == "c_2024_revenue"


def test_dedupe():
    out = sanitize_headers(["Customer Name", "Customer Name", "customer name"])
    assert names(out) == ["customer_name", "customer_name_2", "customer_name_3"]


def test_reserved_words():
    out = sanitize_headers(["order", "SELECT", "User", "table"])
    assert names(out) == ["order_col", "select_col", "user_col", "table_col"]


def test_empty_fallback():
    assert sanitize_headers([""])[0]["name"] == "column"
    assert sanitize_headers(["!!!"])[0]["name"] == "column"


def test_max_length():
    out = sanitize_headers(["a" * 100])
    assert len(out[0]["name"]) == 63


def test_truncated_dedupe_within_63():
    long_h = "b" * 62 + " 1"
    out = sanitize_headers([long_h, long_h])
    assert all(len(h["name"]) <= 63 for h in out)
    assert out[0]["name"] != out[1]["name"]
