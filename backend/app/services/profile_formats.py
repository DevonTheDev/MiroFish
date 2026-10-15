"""Presentation aliases and bounded creation-route metadata for profile files."""

import json
from typing import Any, Dict, Optional


_MODEL_ROUTES = frozenset({"model_json", "model_recovered_json", "model_partial_fields"})
_RULE_ROUTES = frozenset({"rule_requested", "rule_fallback", "basic_fallback"})


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate metadata key")
        result[key] = value
    return result


def normalize_generation_provenance(value: Any) -> Optional[Dict[str, Any]]:
    """Copy a closed version-1 object, without authenticating it or its content."""
    if not isinstance(value, dict) or type(value.get("version")) is not int:
        return None
    if value["version"] != 1 or not isinstance(value.get("route"), str):
        return None
    route = value["route"]
    if route in _MODEL_ROUTES:
        if set(value) != {"version", "route", "provider_reported_length"}:
            return None
        if type(value["provider_reported_length"]) is not bool:
            return None
        return {"version": 1, "route": route,
                "provider_reported_length": value["provider_reported_length"]}
    if route in _RULE_ROUTES and set(value) == {"version", "route"}:
        return {"version": 1, "route": route}
    return None


def decode_generation_provenance(value: Any) -> Optional[Dict[str, Any]]:
    """Decode a bounded CSV cell after the existing reader accepts its row."""
    if not isinstance(value, str):
        return None
    try:
        if len(value.encode("utf-8")) > 256:
            return None
        return normalize_generation_provenance(json.loads(value, object_pairs_hook=_unique_object))
    except (ValueError, UnicodeError):
        return None


def normalize_profile_provenance(row: Any) -> Any:
    """Project only the reserved metadata field on an already decoded object row."""
    if not isinstance(row, dict):
        return row
    profile = dict(row)
    if "generation_provenance" in profile:
        profile["generation_provenance"] = normalize_generation_provenance(
            profile["generation_provenance"]
        )
    return profile


def normalize_twitter_profile(row: Dict[str, Any]) -> Dict[str, Any]:
    """Preserve raw values; add common fields only when their source exists."""
    profile = dict(row)
    for source, common in (("description", "bio"), ("user_char", "persona")):
        if common not in profile and source in profile:
            profile[common] = profile[source]
    if "generation_provenance" in profile:
        profile["generation_provenance"] = decode_generation_provenance(
            profile["generation_provenance"]
        )
    return profile
