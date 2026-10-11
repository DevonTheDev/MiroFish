import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import create_app
from app.api import graph as graph_api
from app.models.project import ProjectManager, ProjectStatus
from app.utils.llm_client import LLMResponseError


def _post_ontology(client):
    return client.post(
        "/api/graph/ontology/generate",
        data={
            "simulation_requirement": "Simulate the discussion.",
            "files": (io.BytesIO(b"A short source document."), "source.md"),
        },
        content_type="multipart/form-data",
    )


def test_ontology_api_returns_safe_truncation_error_and_failed_project(
    tmp_path,
    monkeypatch,
):
    class FailingGenerator:
        def generate(self, **kwargs):
            raise LLMResponseError(
                "LLM JSON output was truncated at the token limit",
                finish_reason="length",
            )

    monkeypatch.setattr(ProjectManager, "PROJECTS_DIR", str(tmp_path))
    monkeypatch.setattr(graph_api, "OntologyGenerator", FailingGenerator)

    app = create_app()
    app.config.update(TESTING=True)
    response = _post_ontology(app.test_client())

    assert response.status_code == 502
    assert response.json["success"] is False
    assert "token limit" in response.json["error"]
    assert "traceback" not in response.json

    project_id = response.json["data"]["project_id"]
    project = ProjectManager.get_project(project_id)
    assert project.status == ProjectStatus.FAILED
    assert project.error == response.json["error"]


def test_ontology_api_does_not_expose_provider_error_body(tmp_path, monkeypatch):
    class ProviderError(RuntimeError):
        status_code = 401
        request_id = "request-safe-id"
        body = {"error": {"message": "SECRET-PROVIDER-BODY"}}

    class FailingGenerator:
        def generate(self, **kwargs):
            raise ProviderError("SECRET-PROVIDER-BODY")

    monkeypatch.setattr(ProjectManager, "PROJECTS_DIR", str(tmp_path))
    monkeypatch.setattr(graph_api, "OntologyGenerator", FailingGenerator)

    app = create_app()
    app.config.update(TESTING=True)
    response = _post_ontology(app.test_client())

    assert response.status_code == 502
    assert "HTTP 401" in response.json["error"]
    assert "request-safe-id" in response.json["error"]
    assert "SECRET-PROVIDER-BODY" not in response.get_data(as_text=True)
    assert "traceback" not in response.json


READABLE_SOURCE_ERRORS = {
    "en": "Please upload at least one document with readable text. For PDFs, the text must be selectable.",
    "zh": "请至少上传一个包含可读取文本的文档；PDF 中的文本必须可选择。",
}
LOCALES_DIR = Path(__file__).resolve().parents[2] / "locales"


@pytest.fixture
def ontology_admission(tmp_path, monkeypatch):
    state = SimpleNamespace(created=[], constructed=[], extracted_writes=[], root=tmp_path)
    original_create = ProjectManager.create_project
    original_write = ProjectManager.save_extracted_text

    def create_project(**kwargs):
        project = original_create(**kwargs)
        state.created.append(project.project_id)
        return project

    def save_extracted_text(project_id, text):
        state.extracted_writes.append((project_id, text))
        original_write(project_id, text)

    class UnexpectedGenerator:
        def __init__(self):
            state.constructed.append("generator constructed")
            raise AssertionError("Rejected source must not construct the generator")

    monkeypatch.setattr(ProjectManager, "PROJECTS_DIR", str(tmp_path))
    monkeypatch.setattr(ProjectManager, "create_project", create_project)
    monkeypatch.setattr(ProjectManager, "save_extracted_text", save_extracted_text)
    monkeypatch.setattr(graph_api, "OntologyGenerator", UnexpectedGenerator)
    app = create_app()
    app.config.update(TESTING=True)
    state.client = app.test_client()
    return state


def _post_sources(state, sources, locale="en", **form):
    return state.client.post(
        "/api/graph/ontology/generate",
        data={
            "simulation_requirement": "Simulate the discussion.",
            **form,
            "files": [(io.BytesIO(content), name) for name, content in sources],
        },
        headers={"Accept-Language": locale} if locale is not None else {},
        content_type="multipart/form-data",
    )


def _assert_source_rejected(state, response, error):
    assert state.constructed == [], "Supported empty sources reached the generator"
    assert state.extracted_writes == []
    assert response.status_code == 400
    assert response.json == {"success": False, "error": error}
    assert len(state.created) == 1
    assert ProjectManager.get_project(state.created[0]) is None
    assert list(state.root.iterdir()) == []


@pytest.mark.parametrize("locale", ["en", "zh"])
@pytest.mark.parametrize(
    "sources",
    [
        [("empty.txt", b"")],
        [("whitespace.md", " \t\r\n\r\n\u2003 ".encode())],
        [("empty.txt", b""), ("whitespace.markdown", b" \r\n\t")],
        [("readable.html", b"Unsupported source text"), ("empty.txt", b"")],
    ],
    ids=["empty-txt", "whitespace-md", "all-empty-batch", "unsupported-plus-empty"],
)
def test_ontology_api_rejects_empty_sources(ontology_admission, sources, locale):
    response = _post_sources(ontology_admission, sources, locale)

    _assert_source_rejected(
        ontology_admission, response, READABLE_SOURCE_ERRORS[locale]
    )


def test_ontology_api_rejects_empty_pdf_extraction(ontology_admission, monkeypatch):
    extracted_pdfs = []

    def extract_empty_pdf(path):
        # The parser boundary represents a PDF with no selectable text; no OCR
        # or optional PDF dependency is needed for this endpoint admission test.
        extracted_pdfs.append((Path(path).suffix, Path(path).read_bytes()))
        return ""

    monkeypatch.setattr(graph_api.FileParser, "_extract_from_pdf", extract_empty_pdf)
    response = _post_sources(ontology_admission, [("scan.pdf", b"pdf fixture")])

    assert extracted_pdfs == [(".pdf", b"pdf fixture")]
    _assert_source_rejected(ontology_admission, response, READABLE_SOURCE_ERRORS["en"])


def test_readable_source_error_exists_in_all_shipped_locales():
    shipped = {path.stem for path in LOCALES_DIR.glob("*.json")} - {"languages"}
    assert shipped == set(READABLE_SOURCE_ERRORS)
    for locale, expected in READABLE_SOURCE_ERRORS.items():
        messages = json.loads((LOCALES_DIR / f"{locale}.json").read_text())
        assert messages["api"]["requireReadableSourceText"] == expected


@pytest.mark.parametrize(
    "locale",
    [None, "unrecognized"]
    + [
        locale
        for locale in json.loads((LOCALES_DIR / "languages.json").read_text())
        if locale not in READABLE_SOURCE_ERRORS
    ],
)
def test_empty_source_error_preserves_locale_fallback(ontology_admission, locale):
    response = _post_sources(ontology_admission, [("empty.txt", b"")], locale)

    _assert_source_rejected(ontology_admission, response, READABLE_SOURCE_ERRORS["zh"])


@pytest.mark.parametrize("additional_context", ["", "Keep the regional context."])
def test_mixed_sources_preserve_generation_and_saved_content(
    ontology_admission, monkeypatch, additional_context
):
    calls = []
    ontology = {"entity_types": [{"name": "Person"}], "edge_types": []}

    class RecordingGenerator:
        def generate(self, **kwargs):
            calls.append(kwargs)
            return {**ontology, "analysis_summary": "A source-based analysis."}

    monkeypatch.setattr(graph_api, "OntologyGenerator", RecordingGenerator)
    sources = [
        ("empty.txt", b""),
        ("first.md", b"  First source.\r\n\r\nMore detail.  "),
        ("whitespace.txt", b" \t\n"),
        ("second.markdown", " Second source: café. ".encode()),
        ("ignored.html", b"Unsupported source"),
    ]
    response = _post_sources(
        ontology_admission,
        sources,
        project_name="Source admission",
        additional_context=additional_context,
    )

    assert response.status_code == 200
    assert response.json["success"] is True
    assert calls == [{
        "document_texts": ["", "First source.\n\nMore detail.", "", "Second source: café."],
        "simulation_requirement": "Simulate the discussion.",
        "additional_context": additional_context or None,
    }]
    expected_text = (
        "\n\n=== empty.txt ===\n"
        "\n\n=== first.md ===\nFirst source.\n\nMore detail."
        "\n\n=== whitespace.txt ===\n"
        "\n\n=== second.markdown ===\nSecond source: café."
    )
    expected_files = [{"filename": name, "size": len(content)} for name, content in sources[:-1]]
    data = response.json["data"]
    assert data["files"] == expected_files
    assert data["total_text_length"] == len(expected_text)
    assert data["ontology"] == ontology
    assert data["analysis_summary"] == "A source-based analysis."
    project_id = data["project_id"]
    project = ProjectManager.get_project(project_id)
    assert project.name == "Source admission"
    assert project.status == ProjectStatus.ONTOLOGY_GENERATED
    assert project.files == expected_files
    assert project.ontology == ontology
    assert project.simulation_requirement == "Simulate the discussion."
    assert project.total_text_length == len(expected_text)
    assert ProjectManager.get_extracted_text(project_id) == expected_text
    assert ontology_admission.extracted_writes == [(project_id, expected_text)]
    assert len(ProjectManager.get_project_files(project_id)) == len(expected_files)


def test_unsupported_only_upload_preserves_existing_rejection(ontology_admission):
    response = _post_sources(ontology_admission, [("source.html", b"Some source text")])

    _assert_source_rejected(
        ontology_admission,
        response,
        "No documents were processed successfully. Please check file formats.",
    )


@pytest.mark.parametrize(
    "sources, requirement, error",
    [
        ([("source.txt", b"Text")], "", "Please provide a simulation requirement (simulation_requirement)"),
        ([], "A requirement", "Please upload at least one document file"),
        ([("", b"")], "A requirement", "Please upload at least one document file"),
    ],
)
def test_required_input_checks_precede_project_creation(
    ontology_admission, sources, requirement, error
):
    response = _post_sources(
        ontology_admission, sources, simulation_requirement=requirement
    )

    assert response.status_code == 400
    assert response.json == {"success": False, "error": error}
    assert ontology_admission.created == []
    assert ontology_admission.constructed == []
    assert ontology_admission.extracted_writes == []
    assert list(ontology_admission.root.iterdir()) == []


def test_parser_failure_preserves_failed_project(ontology_admission, monkeypatch):
    def fail_extraction(path):
        raise ValueError("PRIVATE-PARSER-DETAIL")

    monkeypatch.setattr(graph_api.FileParser, "extract_text", fail_extraction)
    response = _post_sources(ontology_admission, [("source.txt", b"A source")])

    assert response.status_code == 500
    assert response.json["error"] == "Ontology generation failed; check the server logs"
    assert "PRIVATE-PARSER-DETAIL" not in response.get_data(as_text=True)
    project = ProjectManager.get_project(response.json["data"]["project_id"])
    assert project.status == ProjectStatus.FAILED
    assert project.error == response.json["error"]
    assert len(ProjectManager.get_project_files(project.project_id)) == 1
    assert ontology_admission.constructed == []
    assert ontology_admission.extracted_writes == []
