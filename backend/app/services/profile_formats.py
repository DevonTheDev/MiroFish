"""Lossless presentation aliases for OASIS profile files."""

from typing import Any, Dict


def normalize_twitter_profile(row: Dict[str, Any]) -> Dict[str, Any]:
    """Preserve raw values; add common fields only when their source exists."""
    profile = dict(row)
    for source, common in (("description", "bio"), ("user_char", "persona")):
        if common not in profile and source in profile:
            profile[common] = profile[source]
    return profile
