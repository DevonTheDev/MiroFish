"""Small baseline witness for the missing durable profile creation record."""

from app.services.oasis_profile_generator import OasisProfileGenerator
from app.services.zep_entity_reader import EntityNode


def test_explicit_template_has_a_recorded_creation_route():
    generator = object.__new__(OasisProfileGenerator)
    entity = EntityNode("synthetic", "Person", ["Person"], "Summary", {})
    profile = generator.generate_profile_from_entity(entity, 0, use_llm=False)
    assert getattr(profile, "generation_provenance", None) == {"version": 1, "route": "rule_requested"}
