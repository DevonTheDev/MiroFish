"""Existing application services against real local memory (opt-in Neo4j fixture)."""

import pytest

from test_local_memory_integration import URI, client  # noqa: F401

pytestmark = pytest.mark.skipif(not URI, reason="isolated Neo4j not configured")


def test_existing_graph_builder_reader_and_report_search_use_local_memory(
    request, monkeypatch
):
    from app.config import Config
    from app.services import graph_builder, zep_entity_reader, zep_tools

    adapter, state, graph, _settings = request.getfixturevalue("client")
    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "ZEP_API_KEY", None)
    for module in (graph_builder, zep_entity_reader, zep_tools):
        monkeypatch.setattr(module, "get_zep_client", lambda *_args, **_kwargs: adapter)
    group = graph()
    state.typed = True
    builder = graph_builder.GraphBuilderService()
    builder.set_ontology(
        group,
        {
            "entity_types": [
                {"name": "Person", "description": "A person", "attributes": []}
            ],
            "edge_types": [],
        },
    )
    submission = builder.add_text_batches(group, ["Alice knows Bob."])
    episodes = builder._wait_for_batch(submission, timeout=45)
    assert len(episodes) == 1
    data = builder.get_graph_data(group)
    assert {node["name"] for node in data["nodes"]} == {"Alice", "Bob"}
    assert data["edges"][0]["fact"] == "Alice knows Bob"
    assert data["edges"][0]["episodes"] == episodes
    reader = zep_entity_reader.ZepEntityReader()
    filtered = reader.filter_defined_entities(
        group, defined_entity_types=["Person"], enrich_with_edges=True
    )
    assert filtered.filtered_count == 2
    assert all(entity.related_edges for entity in filtered.entities)
    tools = zep_tools.ZepToolsService()
    result = tools.search_graph(group, "Alice knows Bob", scope="edges")
    assert "Alice knows Bob" in result.facts
    assert tools.get_graph_statistics(group)["total_nodes"] == 2
