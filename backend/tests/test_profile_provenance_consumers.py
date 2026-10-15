"""Metadata must not enter existing interview or report prompt text."""

from types import SimpleNamespace

from app.services.zep_tools import InterviewResult, ZepToolsService


def test_interview_selection_questions_and_report_text_ignore_metadata():
    service = object.__new__(ZepToolsService)
    calls = []
    def chat_json(**kwargs):
        calls.append(kwargs)
        return {"selected_indices": [0], "reasoning": "Synthetic selection", "questions": ["Why?"]}
    service._llm_client = SimpleNamespace(chat_json=chat_json)
    row = {"username": "person", "bio": "Bio", "profession": "Researcher", "interested_topics": ["policy"]}
    marked = {**row, "generation_provenance": {"version": 1, "route": "model_json", "provider_reported_length": True}}
    outputs = []
    for profiles in ([row], [marked]):
        selected, indices, reasoning = service._select_agents_for_interview(profiles, "Synthetic question", "Synthetic context", 1)
        questions = service._generate_interview_questions("Synthetic question", "Synthetic context", selected)
        outputs.append(InterviewResult("Topic", questions, selected_agents=selected,
            selection_reasoning=reasoning, total_agents=1).to_text())
        assert indices == [0]
    assert len(calls) == 4  # Both real prompt paths must reach the injected fake.
    assert calls[:2] == calls[2:]
    assert outputs[0] == outputs[1]
    assert "generation_provenance" not in outputs[1]
