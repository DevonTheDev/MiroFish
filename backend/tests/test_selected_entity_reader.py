"""Synthetic graph contracts for exact casts and bounded context reads."""

from types import SimpleNamespace

import pytest

from app.config import Config
from app.services.zep_entity_reader import ZepEntityReader


def _node(uuid, labels=None):
    return SimpleNamespace(
        uuid_=uuid,
        name=uuid.title(),
        labels=["Entity", "Person"] if labels is None else labels,
        summary=f"Summary of {uuid}",
        attributes={},
    )


def _edge(uuid, source, target):
    return SimpleNamespace(
        uuid_=uuid,
        name="KNOWS",
        fact=f"{source} knows {target}",
        source_node_uuid=source,
        target_node_uuid=target,
        attributes={},
    )


class _Pages:
    def __init__(self, items, events, kind, forbidden=False):
        self.items = items
        self.events = events
        self.kind = kind
        self.forbidden = forbidden
        self.calls = 0

    def get_by_graph_id(self, graph_id, *, limit, cursor=None):
        assert graph_id == "synthetic-graph"
        if self.forbidden:
            raise AssertionError(f"Unexpected {self.kind} read")
        self.calls += 1
        self.events.append(self.kind)
        start = int(cursor) if cursor else 0
        stop = min(start + 2, start + limit)
        headers = {"zep-next-cursor": str(stop)} if stop < len(self.items) else {}
        return SimpleNamespace(data=self.items[start:stop], headers=headers)


def _reader(nodes, edges=(), *, forbid_edges=False):
    events = []
    node_api = _Pages(list(nodes), events, "nodes")
    edge_api = _Pages(list(edges), events, "edges", forbidden=forbid_edges)
    reader = object.__new__(ZepEntityReader)
    reader.client = SimpleNamespace(graph=SimpleNamespace(
        node=SimpleNamespace(with_raw_response=node_api),
        edge=SimpleNamespace(with_raw_response=edge_api),
    ))
    return reader, events, node_api, edge_api


def test_exact_cast_preserves_requested_order_and_unselected_neighbor_context():
    reader, events, _, _ = _reader(
        [_node("alice"), _node("bob"), _node("carol"), _node("topic", ["Entity"])],
        [_edge("out", "bob", "carol"), _edge("in", "topic", "bob")],
    )

    result = reader.filter_defined_entities(
        "synthetic-graph", selected_entity_ids=["bob", "alice"], max_nodes=4, max_edges=2,
    )

    assert [entity.uuid for entity in result.entities] == ["bob", "alice"]
    assert result.total_count == 4
    assert result.filtered_count == 2
    assert result.entity_types == {"Person"}
    bob = result.entities[0]
    assert bob.related_edges == [
        {"direction": "outgoing", "edge_name": "KNOWS", "fact": "bob knows carol", "target_node_uuid": "carol"},
        {"direction": "incoming", "edge_name": "KNOWS", "fact": "topic knows bob", "source_node_uuid": "topic"},
    ]
    assert {node["uuid"]: node["summary"] for node in bob.related_nodes} == {
        "carol": "Summary of carol", "topic": "Summary of topic",
    }
    assert events == ["nodes", "nodes", "edges"]


@pytest.mark.parametrize("selected", [
    ["missing"], ["untyped"], ["alice", "alice"], [], [""], [" "], [None], [42], "alice",
])
def test_invalid_exact_cast_fails_before_edge_enrichment(selected):
    reader, _, _, _ = _reader(
        [_node("alice"), _node("untyped", ["Entity", "Node"])], forbid_edges=True,
    )

    with pytest.raises(ValueError):
        reader.filter_defined_entities("synthetic-graph", selected_entity_ids=selected)


def test_exact_cast_rejects_selected_nodes_excluded_by_type_filter():
    reader, _, _, _ = _reader([_node("alice")], forbid_edges=True)

    with pytest.raises(ValueError):
        reader.filter_defined_entities(
            "synthetic-graph", defined_entity_types=["Organization"], selected_entity_ids=["alice"],
        )


@pytest.mark.parametrize(("configured_cap", "count"), [(1, 2), (5000, 1001)])
def test_exact_cast_enforces_loaded_agent_limit_and_hard_ceiling(monkeypatch, configured_cap, count):
    monkeypatch.setattr(Config, "LOCAL_MAX_AGENTS", configured_cap)
    ids = [f"person-{index}" for index in range(count)]
    reader, _, _, _ = _reader([_node(uuid) for uuid in ids], forbid_edges=True)

    with pytest.raises(ValueError, match="limit|cap|maximum"):
        reader.filter_defined_entities("synthetic-graph", selected_entity_ids=ids)


@pytest.mark.parametrize("configured_cap", [None, 0, -1, True, "10"])
def test_exact_cast_rejects_invalid_loaded_agent_limit(monkeypatch, configured_cap):
    monkeypatch.setattr(Config, "LOCAL_MAX_AGENTS", configured_cap)
    reader, _, _, _ = _reader([_node("alice")], forbid_edges=True)

    with pytest.raises(ValueError, match="LOCAL_MAX_AGENTS"):
        reader.filter_defined_entities("synthetic-graph", selected_entity_ids=["alice"])


def test_omitted_selection_keeps_all_typed_entities_without_new_agent_cap(monkeypatch):
    monkeypatch.setattr(Config, "LOCAL_MAX_AGENTS", 1)
    reader, _, _, _ = _reader([_node("alice"), _node("bob"), _node("topic", ["Entity"])])

    result = reader.filter_defined_entities("synthetic-graph")

    assert [entity.uuid for entity in result.entities] == ["alice", "bob"]
    assert result.total_count == 3


def test_exact_cast_can_skip_edge_enrichment():
    reader, _, _, _ = _reader([_node("alice"), _node("bob")], forbid_edges=True)

    result = reader.filter_defined_entities(
        "synthetic-graph", selected_entity_ids=["bob"], enrich_with_edges=False, max_nodes=2,
    )

    assert [entity.uuid for entity in result.entities] == ["bob"]
    assert result.entities[0].related_edges == []


@pytest.mark.parametrize("kind", ["nodes", "edges"])
def test_graph_bound_rejects_overflow_and_stops_after_sentinel(kind):
    reader, _, nodes, edges = _reader(
        [_node(f"person-{index}") for index in range(10)],
        [_edge(f"edge-{index}", "alice", "bob") for index in range(10)],
    )

    with pytest.raises(ValueError, match=kind):
        getattr(reader, f"get_all_{kind}")("synthetic-graph", max_items=2)

    assert (nodes if kind == "nodes" else edges).calls == 2


@pytest.mark.parametrize("kind", ["nodes", "edges"])
def test_graph_bound_accepts_exact_limit(kind):
    reader, _, _, _ = _reader(
        [_node("alice"), _node("bob")], [_edge("out", "alice", "bob"), _edge("in", "bob", "alice")],
    )

    result = getattr(reader, f"get_all_{kind}")("synthetic-graph", max_items=2)

    assert len(result) == 2


@pytest.mark.parametrize("kind", ["nodes", "edges"])
@pytest.mark.parametrize("bound", [0, -1, True, 1.5, "2"])
def test_graph_bounds_must_be_positive_integers(kind, bound):
    reader, _, _, _ = _reader([])

    with pytest.raises(ValueError, match="max_items"):
        getattr(reader, f"get_all_{kind}")("synthetic-graph", max_items=bound)


def test_filter_rejects_node_overflow_before_reading_edges():
    reader, _, _, _ = _reader([_node("alice"), _node("bob")], forbid_edges=True)

    with pytest.raises(ValueError, match="nodes"):
        reader.filter_defined_entities("synthetic-graph", selected_entity_ids=["alice"], max_nodes=1)


def test_filter_rejects_edge_overflow_instead_of_partial_context():
    reader, _, _, _ = _reader(
        [_node("alice"), _node("bob")], [_edge("out", "alice", "bob"), _edge("in", "bob", "alice")],
    )

    with pytest.raises(ValueError, match="edges"):
        reader.filter_defined_entities("synthetic-graph", selected_entity_ids=["alice"], max_edges=1)


@pytest.mark.parametrize("options", [
    {"selected_entity_ids": ["alice"]}, {"max_nodes": 10}, {"max_edges": 10},
])
def test_planned_reads_reject_duplicate_provider_ids_before_context(options):
    reader, _, _, _ = _reader([_node("alice"), _node("alice")], forbid_edges=True)

    with pytest.raises(ValueError, match="^Graph entity records are invalid$"):
        reader.filter_defined_entities("synthetic-graph", **options)


@pytest.mark.parametrize("options", [
    {"selected_entity_ids": ["alice"]}, {"max_nodes": 10}, {"max_edges": 10},
])
@pytest.mark.parametrize(("field", "value"), [
    ("uuid_", None), ("uuid_", 0), ("uuid_", False), ("uuid_", []),
    ("uuid_", ""), ("uuid_", "node space"), ("uuid_", "nödé"), ("uuid_", "n" * 129),
    ("labels", None), ("labels", "Person"), ("labels", ""), ("labels", {}),
    ("labels", ["Entity", 12]), ("labels", ["Entity", ""]),
    ("labels", ["Entity", "  "]), ("labels", ["Entity", "T" * 129]),
    ("name", None), ("name", False), ("name", {}),
    ("summary", None), ("summary", 0), ("summary", []),
])
def test_planned_reads_reject_malformed_raw_provider_fields_before_context(options, field, value):
    node = _node("alice")
    setattr(node, field, value)
    reader, _, _, _ = _reader([node], forbid_edges=True)

    with pytest.raises(ValueError, match="^Graph entity records are invalid$"):
        reader.filter_defined_entities("synthetic-graph", **options)


def test_malformed_primary_provider_id_cannot_hide_behind_uuid_alias():
    node = _node("alice")
    node.uuid_ = False
    node.uuid = "alice"
    reader, _, _, _ = _reader([node], forbid_edges=True)

    with pytest.raises(ValueError, match="^Graph entity records are invalid$"):
        reader.filter_defined_entities("synthetic-graph", selected_entity_ids=["alice"])


def test_bounded_reader_validates_raw_provider_records_without_filter():
    node = _node("alice")
    node.labels = ""
    reader, _, _, _ = _reader([node])

    with pytest.raises(ValueError, match="^Graph entity records are invalid$"):
        reader.get_all_nodes("synthetic-graph", max_items=10)


def test_strict_reader_accepts_boundary_lengths_and_untyped_context_nodes():
    node = _node("n" * 128, ["Entity", "T" * 128])
    node.name = ""
    node.summary = ""
    reader, _, _, _ = _reader([node, _node("topic", [])], forbid_edges=True)

    result = reader.filter_defined_entities("synthetic-graph", max_nodes=2, enrich_with_edges=False)

    assert result.entities[0].uuid == "n" * 128
    assert result.entities[0].get_entity_type() == "T" * 128
    assert result.filtered_count == 1
    assert result.total_count == 2


def test_omitted_selection_and_bounds_preserve_legacy_provider_normalization():
    first = _node("alice")
    first.labels = ""
    first.name = None
    first.summary = 0
    reader, _, _, _ = _reader([first, _node("alice"), _node("alice")])

    nodes = reader.get_all_nodes("synthetic-graph")
    result = reader.filter_defined_entities("synthetic-graph")

    assert nodes[0]["labels"] == []
    assert nodes[0]["name"] == ""
    assert nodes[0]["summary"] == ""
    assert [entity.uuid for entity in result.entities] == ["alice", "alice"]
