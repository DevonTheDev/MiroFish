"""Saved phrase/outcome HTTP contract through the real Flask route and reader."""

import json

import pytest

from app.services import simulation_comparison as shared
from scripts.action_logger import PlatformActionLogger
from test_saved_activity import action, roots as roots, rows
from test_saved_activity_api import client as client, inventory


def test_search_real_logger_decodes_strings_and_preserves_readonly_sources(client, roots):
    logger = PlatformActionLogger("twitter", str(roots[1] / "sim_saved"))
    logger.log_action(0, 0, "Saved", "POST", {"nested": ["中文 Straße <script>literal</script>"]}, success=False)
    logger.log_action(0, 0, "Saved", "POST", {"nested": ["中文 Straße <script>literal</script>"]})
    rows(roots, "reddit")
    before = inventory(roots)
    response = client.get("/api/simulation/sim_saved/saved-actions", query_string={
        "q": "中文 STRASSE", "case_sensitive": "false", "outcome": "failed",
        "agent_id": "000", "round_num": "0", "platform": "twitter", "action_type": "POST",
    })
    assert response.status_code == 200, response.json
    data = response.json["data"]
    assert data["filters"] == dict(platform="twitter", agent_id="0", round_num="0", action_type="POST",
                                   q="中文 STRASSE", case_sensitive=False, outcome="failed")
    assert data["matched_count"] == 1
    assert data["actions"][0]["match_preview"] == "中文 Straße <script>literal</script>"
    assert json.loads(data["actions"][0]["details_json"])["success"] is False
    assert "PRIVATE_" not in response.get_data(as_text=True)
    assert inventory(roots) == before


@pytest.mark.parametrize("query", [
    "q=", "q=%20", "q=%E2%80%83", "q=" + "x" * 201,
    "q=a&q=b", "q=%00", "q=a%0Ab", "q=%0D", "q=%09", "q=%7F", "q=%C2%85",
    "q=%E2%80%A8", "q=%E2%80%A9", "case_sensitive=", "case_sensitive=True",
    "case_sensitive=False", "case_sensitive=1", "case_sensitive=0", "case_sensitive=yes",
    "case_sensitive=true%20", "case_sensitive=false&case_sensitive=true",
    "outcome=", "outcome=Success", "outcome=false", "outcome=failure", "outcome=unknown%20",
    "outcome=success&outcome=failed",
])
def test_search_http_validation_precedes_any_source_read(client, roots, monkeypatch, query):
    before = inventory(roots)
    monkeypatch.setattr(shared, "_paths", lambda *args: pytest.fail("Invalid search reached storage"))
    response = client.get("/api/simulation/sim_saved/saved-actions?" + query)
    assert response.status_code == 400
    assert response.json["error_code"] == "invalid_filters"
    assert inventory(roots) == before


def test_http_case_choice_is_strict_and_retained_without_phrase(client, roots):
    rows(roots, values=[action(result="Needle")])
    default = client.get("/api/simulation/sim_saved/saved-actions").json["data"]
    assert default["filters"]["q"] is None
    assert default["filters"]["case_sensitive"] is False
    assert default["filters"]["outcome"] is None
    assert default["actions"][0]["match_preview"] is None
    sensitive = client.get("/api/simulation/sim_saved/saved-actions?q=needle&case_sensitive=true")
    assert sensitive.status_code == 200
    assert sensitive.json["data"]["matched_count"] == 0
    no_phrase = client.get("/api/simulation/sim_saved/saved-actions?case_sensitive=true")
    assert no_phrase.status_code == 200
    assert no_phrase.json["data"]["filters"]["case_sensitive"] is True
    assert no_phrase.json["data"]["actions"][0]["match_preview"] is None


def test_http_query_preserves_spaces_and_200_unicode_codepoints(client, roots):
    phrase = " " + "😀" * 198 + " "
    rows(roots, values=[action(result=phrase)])
    response = client.get("/api/simulation/sim_saved/saved-actions", query_string={"q": phrase})
    assert response.status_code == 200
    assert response.json["data"]["filters"]["q"] == phrase
    assert response.json["data"]["actions"][0]["match_preview"] == phrase
    rejected = client.get("/api/simulation/sim_saved/saved-actions", query_string={"q": "😀" * 201})
    assert rejected.status_code == 400 and rejected.json["error_code"] == "invalid_filters"


def test_http_bom_is_a_literal_phrase_not_blank_whitespace(client, roots):
    rows(roots, values=[action(result="a\ufeffb")])
    response = client.get("/api/simulation/sim_saved/saved-actions", query_string={"q": "\ufeff"})
    assert response.status_code == 200
    assert response.json["data"]["filters"]["q"] == "\ufeff"
    assert response.json["data"]["actions"][0]["match_preview"] == "a\ufeffb"


def test_http_filtered_pages_pin_revision_and_keep_duplicate_attempts(client, roots):
    original = action(result="needle", success=False)
    path = rows(roots, values=[original, action(result="other", success=False), original, original])
    query = dict(q="NEEDLE", case_sensitive="false", outcome="failed", limit=1)
    first_response = client.get("/api/simulation/sim_saved/saved-actions", query_string=query)
    assert first_response.status_code == 200
    first = first_response.json["data"]
    second_response = client.get("/api/simulation/sim_saved/saved-actions", query_string={**query, "offset": 1, "revision": first["source_revision"]})
    assert second_response.status_code == 200
    second = second_response.json["data"]
    assert first["matched_count"] == second["matched_count"] == 3
    assert [row["record_id"] for row in second["actions"]] == ["twitter:3"]
    assert second["filters"] == first["filters"]
    with path.open("a") as stream:
        stream.write(json.dumps(original) + "\n")
    stale = client.get("/api/simulation/sim_saved/saved-actions", query_string={**query, "offset": 2, "revision": first["source_revision"]})
    assert stale.status_code == 409 and stale.json["error_code"] == "sources_changed"
    fresh = client.get("/api/simulation/sim_saved/saved-actions", query_string=query)
    assert fresh.status_code == 200 and fresh.json["data"]["matched_count"] == 4


@pytest.mark.parametrize("outcome,expected", [("success", ["0"]), ("failed", ["1"]), ("unknown", ["2", "3", "4"])])
def test_http_outcome_uses_boolean_flags_only(client, roots, outcome, expected):
    rows(roots, values=[action(agent_id=i, success=value, result="needle") for i, value in enumerate([True, False, None, 1, "false"])])
    response = client.get("/api/simulation/sim_saved/saved-actions", query_string={"outcome": outcome})
    assert response.status_code == 200
    assert [row["agent_id"] for row in response.json["data"]["actions"]] == expected


def test_http_search_preview_and_filter_echo_cannot_bypass_response_limit(client, roots, monkeypatch):
    import app.services.saved_activity as reader
    rows(roots, values=[action(result="界" * 240)])
    monkeypatch.setattr(reader, "MAX_RESPONSE_BYTES", 1800)
    response = client.get("/api/simulation/sim_saved/saved-actions", query_string={"q": "界" * 200})
    assert response.status_code == 413
    assert response.json["error_code"] == "response_too_large"
