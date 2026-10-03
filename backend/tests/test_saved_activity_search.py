"""Phrase search inspects saved string values while preserving source admission."""

import json

import pytest

from app.services import simulation_comparison as shared
from scripts.action_logger import ActionLogger, PlatformActionLogger
from test_saved_activity import action, log_path, read, reader as reader, roots as roots, rows


def test_default_filters_and_absent_preview_preserve_saved_details(reader, roots):
    original = action(result={"text": "Straße 中文 😀"})
    rows(roots, values=[original])
    result = read(reader, roots)
    assert result["filters"] == dict(platform=None, agent_id=None, round_num=None,
                                     action_type=None, q=None, case_sensitive=False, outcome=None)
    assert result["actions"][0]["match_preview"] is None
    assert json.loads(result["actions"][0]["details_json"]) == original


@pytest.mark.parametrize("text,phrase,case_sensitive,matched", [
    ("A literal [x].*? + phrase", "[x].*? +", False, True),
    ("Decoded 中文 café 😀", "中文 CAFÉ 😀", False, True),
    ("Before Needle after", "needle", False, True),
    ("Before Needle after", "needle", True, False),
    ("Before Needle after", "Needle", True, True),
    ("a x b", " x ", False, True),
    ("ax b", " x ", False, False),
    ("Straße", "STRASSE", False, True),
    ("STRASSE", "Straße", False, True),
    ("Straße", "STRASSE", True, False),
    ("oﬃce", "office", False, True),
    ("office", "oﬃce", False, True),
    ("İstanbul", "i\u0307stanbul", False, True),
    ("café", "cafe\u0301", False, False),
    ("cafe\u0301", "café", False, False),
    ("café", "cafe", False, False),
    ("ß", "s", False, True),
    ("literal \ufeff marker", "\ufeff", False, True),
    ("\ud800literal", "\ud800", False, True),
])
def test_literal_decoded_unicode_casefold_without_normalization(reader, roots, text, phrase, case_sensitive, matched):
    original = action(action_type="X", result={"nested": [None, {"content": text}]})
    rows(roots, values=[original])
    result = read(reader, roots, q=phrase, case_sensitive=case_sensitive)
    assert result["filters"]["q"] == phrase
    assert result["filters"]["case_sensitive"] is case_sensitive
    assert result["matched_count"] == int(matched)
    if matched:
        assert result["actions"][0]["match_preview"] == text
        assert json.loads(result["actions"][0]["details_json"]) == original


@pytest.mark.parametrize("payload,phrase", [
    ({"hidden marker": "ordinary"}, "hidden marker"),
    ({"a": 123456789}, "123456789"),
    ({"a": True}, "true"),
    ({"a": False}, "false"),
    ({"a": None}, "null"),
    ({"a": ["joined", "phrase"]}, "joinedphrase"),
    ({"a": ["joined", "phrase"]}, "joined phrase"),
    ({"first": "joined", "second": "phrase"}, "joinedphrase"),
])
def test_keys_nonstring_scalars_and_cross_value_phrases_do_not_match(reader, roots, payload, phrase):
    rows(roots, values=[action(result=payload)])
    assert read(reader, roots, q=phrase)["matched_count"] == 0


@pytest.mark.parametrize("field", ["agent_name", "timestamp", "action_type", "action_args", "result"])
def test_all_saved_string_values_are_searchable(reader, roots, field):
    rows(roots, values=[action(**{field: "searchable marker"})])
    result = read(reader, roots, q="searchable marker")
    assert result["matched_count"] == 1
    assert result["actions"][0]["match_preview"] == "searchable marker"


def test_iterative_nested_value_order_returns_first_matching_string(reader, roots):
    nested = {"first": ["no", {"saved": "FIRST needle"}], "second": "SECOND needle"}
    for _ in range(150):
        nested = [nested]
    rows(roots, values=[action(result=nested, action_args={"text": "THIRD needle"})])
    result = read(reader, roots, q="needle")
    assert result["matched_count"] == 1
    assert result["actions"][0]["match_preview"] == "FIRST needle"


@pytest.mark.parametrize("prefix,phrase,body", [
    ("x" * 90, "Needle", "Needle"),
    ("ß" * 90, "needle", "Needle"),
    ("😀" * 90, "NEEDLE", "Needle"),
    ("x" * 90, "s", "ß"),
    ("x" * 90, "si", "ßi"),
    ("x" * 90, "\u0307", "İ"),
    ("", "ﬃ" * 200, "ffi" * 200),
])
def test_preview_maps_first_folded_start_to_original_bounded_text(reader, roots, prefix, phrase, body):
    value = prefix + body + "z" * 300
    rows(roots, values=[action(action_type="X", result=value)])
    result = read(reader, roots, q=phrase)
    preview = result["actions"][0]["match_preview"]
    start = max(0, len(prefix) - 40)
    assert preview == value[start:start + 240]
    assert len(preview) <= 240


def test_first_occurrence_determines_preview(reader, roots):
    value = "x" * 45 + "needle" + "x" * 250 + "needle"
    rows(roots, values=[action(result=value)])
    assert read(reader, roots, q="NEEDLE")["actions"][0]["match_preview"] == value[5:245]


def test_no_query_does_not_walk_string_values(reader, roots, monkeypatch):
    rows(roots, values=[action(result={"text": "irrelevant"})])
    monkeypatch.setattr(reader, "_first_string_match", lambda *args: pytest.fail("No-query request traversed saved text"), raising=False)
    result = read(reader, roots, case_sensitive=True)
    assert result["matched_count"] == 1
    assert result["filters"]["case_sensitive"] is True
    assert result["actions"][0]["match_preview"] is None


@pytest.mark.parametrize("kwargs", [
    {"q": ""}, {"q": " "}, {"q": "\u2003"}, {"q": "x" * 201},
    {"q": 1}, {"q": True}, {"q": []}, {"q": {}},
    *({"q": "a" + char + "b"} for char in ("\x00", "\n", "\r", "\t", "\x7f", "\x85", "\u2028", "\u2029")),
    *({"case_sensitive": value} for value in (None, 0, 1, "true", "false", [], {})),
    *({"outcome": value} for value in ("", "Success", "true", "failure", "unknown ", 0, False, [], {})),
])
def test_invalid_search_filters_fail_before_storage(reader, roots, monkeypatch, kwargs):
    monkeypatch.setattr(shared, "_paths", lambda *args: pytest.fail("Invalid search reached storage"))
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots, **kwargs)
    assert (error.value.code, error.value.status_code) == ("invalid_filters", 400)


def test_phrase_limit_uses_original_codepoints_and_preserves_spaces(reader, roots):
    phrase = " " + "😀" * 198 + " "
    rows(roots, values=[action(result=phrase)])
    result = read(reader, roots, q=phrase)
    assert result["matched_count"] == 1
    assert result["filters"]["q"] == phrase
    assert result["actions"][0]["match_preview"] == phrase


@pytest.mark.parametrize("outcome,expected", [("success", ["0"]), ("failed", ["1"]), ("unknown", [str(i) for i in range(2, 9)])])
def test_outcome_matches_only_exact_stored_boolean(reader, roots, outcome, expected):
    values = [True, False, None, 1, 0, "true", "false", []]
    rows(roots, values=[action(agent_id=i, success=value, result="needle") for i, value in enumerate(values)] + [action(agent_id=8, result="needle")])
    result = read(reader, roots, q="needle", outcome=outcome)
    assert result["filters"]["outcome"] == outcome
    assert result["matched_count"] == len(expected)
    assert [row["agent_id"] for row in result["actions"]] == expected
    assert all(row["success"] is {"success": True, "failed": False, "unknown": None}[outcome] for row in result["actions"])


@pytest.mark.parametrize("legacy", [False, True])
def test_actual_producers_default_and_explicit_outcomes_remain_literal(reader, roots, legacy):
    if legacy:
        logger = ActionLogger(str(log_path(roots, "legacy")))
        logger.log_action(0, "twitter", 0, "Saved", "POST", {"text": "Straße"})
        logger.log_action(0, "reddit", 1, "Saved", "POST", {"text": "Straße"}, success=False)
    else:
        logger = PlatformActionLogger("twitter", str(roots[1] / "sim_saved"))
        logger.log_action(0, 0, "Saved", "POST", {"text": "Straße"})
        logger.log_action(0, 1, "Saved", "POST", {"text": "Straße"}, success=False)
    success = read(reader, roots, q="STRASSE", outcome="success")
    failed = read(reader, roots, q="STRASSE", outcome="failed")
    assert [row["agent_id"] for row in success["actions"]] == ["0"]
    assert [row["agent_id"] for row in failed["actions"]] == ["1"]
    assert read(reader, roots, outcome="unknown")["matched_count"] == 0


def test_all_filters_count_attempts_once_before_pagination(reader, roots):
    huge = int("9" * 64)
    match = action(agent_id=huge, round=7, success=False, result=["Needle needle", {"text": "needle"}])
    rows(roots, values=[match, action(result="Needle"), match, action(**{**match, "success": True}), match])
    rows(roots, "reddit", [match])
    filters = dict(platform="twitter", agent_id=str(huge), round_num="0007", action_type="LIKE_POST", q="needle", outcome="failed")
    first = read(reader, roots, **filters, limit=1)
    second = read(reader, roots, **filters, offset=1, limit=2, revision=first["source_revision"])
    assert first["matched_count"] == second["matched_count"] == 3
    assert first["has_more"] is True and second["has_more"] is False
    assert [row["record_id"] for row in second["actions"]] == ["twitter:3", "twitter:5"]
    assert second["actions"][0]["agent_id"] == str(huge)
    assert json.loads(second["actions"][0]["details_json"]) == match
    assert read(reader, roots, q="absent", case_sensitive=True, outcome="success")["source_revision"] == first["source_revision"]


def test_previews_are_built_only_for_retained_rows(reader, roots, monkeypatch):
    rows(roots, values=[action(result="ß" * 500 + "needle")] * 3)
    revision = read(reader, roots)["source_revision"]
    calls = []
    original = reader._match_preview
    def counted(*args):
        calls.append(args)
        return original(*args)
    monkeypatch.setattr(reader, "_match_preview", counted)
    result = read(reader, roots, q="needle", limit=1, offset=1, revision=revision)
    assert result["matched_count"] == 3
    assert len(calls) == 1


@pytest.mark.parametrize("budget,value", [("MAX_LOG_RECORDS", 2), ("MAX_ACTION_TYPES", 1), ("MAX_LINE_BYTES", 150), ("MAX_LOG_BYTES", 500)])
def test_search_late_source_refusal_rolls_back_matches_and_page(reader, roots, monkeypatch, budget, value):
    rows(roots, values=[action(result="needle"), action(result="needle"), action(action_type="OTHER", result="x" * 800)])
    rows(roots, "reddit", [action(agent_id=10, result="needle"), action(agent_id=11, result="needle")])
    monkeypatch.setattr(shared, budget, value)
    first = read(reader, roots, q="needle", limit=1)
    second = read(reader, roots, q="needle", offset=1, limit=1, revision=first["source_revision"])
    assert first["matched_count"] == second["matched_count"] == 2
    assert [row["record_id"] for row in first["actions"]] == ["reddit:1"]
    assert [row["record_id"] for row in second["actions"]] == ["reddit:2"]
    assert first["platform_availability"]["twitter"] == "unavailable"


def test_search_late_io_failure_discards_tentative_matches(reader, roots, monkeypatch):
    path = rows(roots, values=[action(result="needle"), action(result="needle")])
    rows(roots, "reddit", [action(result="needle")])
    original = shared._open_source
    class BrokenStream:
        def __init__(self, stream):
            self.stream, self.reads = stream, 0
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.stream.close()
        def fileno(self):
            return self.stream.fileno()
        def readline(self, maximum):
            self.reads += 1
            if self.reads == 2:
                raise OSError("private source failure")
            return self.stream.readline(maximum)
    monkeypatch.setattr(shared, "_open_source", lambda source: BrokenStream(original(source)) if str(source) == str(path) else original(source))
    result = read(reader, roots, q="needle")
    assert result["matched_count"] == 1
    assert [row["record_id"] for row in result["actions"]] == ["reddit:1"]
    assert {"code": "source_unreadable", "platform": "twitter"} in result["warnings"]


def test_search_global_refusal_clears_matches_and_page_overflow(reader, roots, monkeypatch):
    rows(roots, values=[action(action_type="A", result="needle" + "x" * 1000)])
    rows(roots, "reddit", [action(action_type="B", result="needle")])
    monkeypatch.setattr(reader, "MAX_PAGE_BYTES", 500)
    monkeypatch.setattr(shared, "MAX_ACTION_TYPES", 1)
    result = read(reader, roots, q="needle")
    assert result["availability"] == "unavailable"
    assert result["matched_count"] is None and result["actions"] == []


def test_search_preserves_unavailable_and_partial_count_meanings(reader, roots):
    missing = read(reader, roots, q="needle", outcome="success")
    assert missing["availability"] == "unavailable" and missing["matched_count"] is None
    path = rows(roots, values=[action(result="needle", success=True), action(result="other")])
    with path.open("a") as stream:
        stream.write("invalid\n")
    partial = read(reader, roots, q="needle", outcome="success")
    assert partial["availability"] == "partial" and partial["matched_count"] == 1
    assert {"code": "invalid_records", "platform": "twitter", "count": 1} in partial["warnings"]


def test_changed_revision_supersedes_search_output_overflow(reader, roots, monkeypatch):
    path = rows(roots, values=[action(result="needle" + "x" * 1000)])
    original = shared._open_source
    changed = False
    def changing_open(source):
        nonlocal changed
        if not changed:
            changed = True
            with path.open("a") as stream:
                stream.write("{}\n")
        return original(source)
    monkeypatch.setattr(shared, "_open_source", changing_open)
    monkeypatch.setattr(reader, "MAX_PAGE_BYTES", 500)
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots, q="needle")
    assert (error.value.code, error.value.status_code) == ("sources_changed", 409)


def test_preview_bytes_are_included_in_page_budget(reader, roots, monkeypatch):
    rows(roots, values=[action(result="界" * 240)])
    result = read(reader, roots, q="界")
    required = len(reader._json(result["actions"]).encode("ascii"))
    monkeypatch.setattr(reader, "MAX_PAGE_BYTES", required - 1)
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots, q="界")
    assert (error.value.code, error.value.status_code) == ("response_too_large", 413)
    monkeypatch.setattr(reader, "MAX_PAGE_BYTES", required)
    assert read(reader, roots, q="界")["matched_count"] == 1


def test_query_and_preview_bytes_are_included_in_response_budget(reader, roots, monkeypatch):
    rows(roots, values=[action(result="界" * 240)])
    result = read(reader, roots, q="界" * 200)
    required = len(reader._json({"success": True, "data": result}).encode("ascii"))
    monkeypatch.setattr(reader, "MAX_RESPONSE_BYTES", required - 1)
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots, q="界" * 200)
    assert (error.value.code, error.value.status_code) == ("response_too_large", 413)


def test_search_large_rows_outside_page_do_not_overflow_retained_page(reader, roots, monkeypatch):
    rows(roots, values=[action(result="needle" + "x" * 1000), action(result="needle")])
    revision = read(reader, roots, q="absent")["source_revision"]
    monkeypatch.setattr(reader, "MAX_PAGE_BYTES", 500)
    result = read(reader, roots, q="needle", offset=1, limit=1, revision=revision)
    assert result["matched_count"] == 2
    assert [row["record_id"] for row in result["actions"]] == ["twitter:2"]
