"""Template personas must not run graph search or embedding work."""

from app.services.oasis_profile_generator import OasisProfileGenerator
from app.services.zep_entity_reader import EntityNode


def _entity():
    return EntityNode(
        uuid="synthetic-person", name="Alice", labels=["Entity", "Person"],
        summary="Alice studies local community discussions.", attributes={},
        related_edges=[{"fact": "Alice follows the neighborhood forum."}],
        related_nodes=[],
    )


def test_template_profile_never_builds_search_context(monkeypatch):
    generator = object.__new__(OasisProfileGenerator)

    def forbidden_context(*_args, **_kwargs):
        raise AssertionError("Template profiles must not build retrieval context")

    monkeypatch.setattr(generator, "_build_entity_context", forbidden_context)

    profile = generator.generate_profile_from_entity(_entity(), user_id=7, use_llm=False)

    assert profile.name == "Alice"
    assert profile.user_id == 7
    assert profile.source_entity_uuid == "synthetic-person"
    assert profile.source_entity_type == "Person"
    assert profile.persona == "Alice studies local community discussions."


def test_llm_profile_still_receives_built_graph_context(monkeypatch):
    generator = object.__new__(OasisProfileGenerator)
    monkeypatch.setattr(generator, "_search_zep_for_entity", lambda _entity: {
        "facts": ["Alice reads the synthetic city bulletin."], "node_summaries": [],
    })

    def generate_from_context(**kwargs):
        assert "Alice follows the neighborhood forum." in kwargs["context"]
        assert "Alice reads the synthetic city bulletin." in kwargs["context"]
        return {"persona": kwargs["context"], "bio": "Synthetic profile"}

    monkeypatch.setattr(generator, "_generate_profile_with_llm", generate_from_context)

    profile = generator.generate_profile_from_entity(_entity(), user_id=7, use_llm=True)

    assert "Alice follows the neighborhood forum." in profile.persona
    assert "Alice reads the synthetic city bulletin." in profile.persona
