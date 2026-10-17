from app.ingest.headers import sanitize_headers
from app.ingest.profile import profile_table
from app.ingest.relationships import detect_relationships
from app.ingest.types import coerce_value, infer_type


class TestInferType:
    def test_booleans(self):
        assert infer_type(["yes", "no", "YES"]).type == "boolean"
        assert infer_type(["true", "false"]).type == "boolean"
        assert infer_type(["y", "n"]).type == "boolean"

    def test_zero_one_only_when_nothing_else(self):
        assert infer_type(["1", "0", "1"]).type == "boolean"
        assert infer_type(["0", "1", "2", "5"]).type == "integer"

    def test_numbers(self):
        assert infer_type(["1", "2", "300"]).type == "integer"
        assert infer_type(["1.5", "2", "3.25"]).type == "decimal"

    def test_percent_column(self):
        r = infer_type(["12%", "8.5%", "20%"])
        assert r.type == "decimal" and r.is_percent

    def test_whole_percent_ratios_retain_percent_metadata(self):
        r = infer_type(["0%", "100%"])
        assert r.type == "integer" and r.is_percent
        assert coerce_value("0%", r.type, None).value == "0"
        assert coerce_value("100%", r.type, None).value == "1"

    def test_fractional_percent_ratios_stay_decimal(self):
        r = infer_type(["0%", "50%", "100%"])
        assert r.type == "decimal" and r.is_percent

    def test_plain_integer_mix_does_not_get_percent_metadata(self):
        r = infer_type(["10", "20", "100%"])
        assert r.type == "integer" and not r.is_percent

    def test_dates(self):
        assert infer_type(["2024-01-15", "2024-02-20"]).date_format == "yyyy-mm-dd"
        assert infer_type(["20/01/2024", "05/02/2024"]).date_format == "dd/mm/yyyy"
        assert infer_type(["22-Jan-2024"]).date_format == "dd-Mon-yyyy"
        assert infer_type(["2024-01-15 09:30:00"]).type == "timestamp"

    def test_threshold(self):
        assert infer_type(["42"] * 96 + ["oops", "bad"]).type == "integer"
        assert infer_type(["42"] * 94 + ["oops"] * 6).type == "text"

    def test_coerce(self):
        assert coerce_value("NA", "integer", None).value is None
        assert coerce_value("YES", "boolean", None).value == "true"
        assert coerce_value("05/01/2024", "date", "dd/mm/yyyy").value == "2024-01-05"
        assert not coerce_value("oops", "integer", None).ok


class TestProfile:
    def test_candidate_key(self):
        p = profile_table(sanitize_headers(["id", "name"]), [["1", "a"], ["2", "b"]])
        assert p.columns[0].is_candidate_key
        p2 = profile_table(sanitize_headers(["id"]), [["1"], ["1"]])
        assert not p2.columns[0].is_candidate_key

    def test_stats(self):
        rows = [[str(i + 1)] for i in range(19)] + [["oops"]]
        c = profile_table(sanitize_headers(["score"]), rows).columns[0]
        assert c.data_type == "integer"
        assert c.coerced_count == 1
        assert c.min_value == "1" and c.max_value == "19"

    def test_top_values_and_nullpct(self):
        rows = [["red"]] * 5 + [["blue"]] * 3 + [["NA"]] + [["green"]]
        c = profile_table(sanitize_headers(["color"]), rows).columns[0]
        assert c.null_pct == 10.0
        assert c.top_values[0] == {"value": "red", "count": 5}


class TestRelationships:
    def test_fk_detection(self):
        customers = profile_table(
            sanitize_headers(["id", "name"]), [[str(i), f"c{i}"] for i in range(1, 13)]
        )
        orders = profile_table(
            sanitize_headers(["Order ID", "Customer ID", "Amount"]),
            [[str(1000 + i), str((i % 12) + 1), str(100 * i)] for i in range(1, 17)],
        )
        rels = detect_relationships({"customers": customers, "orders": orders})
        assert len(rels) == 1
        r = rels[0]
        assert (r.from_table, r.from_column) == ("orders", "customer_id")
        assert (r.to_table, r.to_column) == ("customers", "id")
        assert r.overlap == 1.0

    def test_below_threshold_rejected(self):
        parents = profile_table(sanitize_headers(["id"]), [[str(i)] for i in range(3)])
        children = profile_table(sanitize_headers(["parent_id"]), [[str(i)] for i in range(10)])
        assert detect_relationships({"parents": parents, "children": children}) == []


class TestParityRounding:
    def test_null_pct_rounds_half_up_like_js(self):
        rows = [["5"]] * 31 + [["NA"]]
        c = profile_table(sanitize_headers(["v"]), rows).columns[0]
        assert c.null_pct == 3.13

    def test_overlap_rounds_half_up_like_js(self):
        parent = profile_table(sanitize_headers(["id"]), [[f"v{i}"] for i in range(1801)])
        child = profile_table(sanitize_headers(["customer_id"]), [[f"v{i}"] for i in range(2000)])
        rels = detect_relationships({"customers": parent, "orders": child})
        assert len(rels) == 1
        assert rels[0].overlap == 0.901

    def test_text_ties_order_by_code_point(self):
        labels = ["A", "a", "z", "é", "中", "\uffff", "\U00010000", "b", "c", "d", "e", "f"]
        rows = [["red"], ["red"]] + [[v] for v in labels]
        top = profile_table(sanitize_headers(["label"]), rows).columns[0].top_values
        assert top[0] == {"value": "red", "count": 2}
        assert [t["value"] for t in top] == [
            "red",
            "A",
            "a",
            "b",
            "c",
            "d",
            "e",
            "f",
            "z",
            "é",
        ]

    def test_astral_and_bmp_high_code_points_order_by_code_point(self):
        rows = [["\U00010000"], ["\uffff"], ["中"]]
        top = profile_table(sanitize_headers(["label"]), rows).columns[0].top_values
        assert [t["value"] for t in top] == ["中", "\uffff", "\U00010000"]
