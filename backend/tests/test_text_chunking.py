"""Text chunking must preserve progress even with large valid overlaps."""

import sys

import pytest

from app.utils.file_parser import split_text_into_chunks


def split_with_progress_guard(text, chunk_size=500, overlap=50):
    """Bound a historical infinite loop without threads, sleeps or leaked work."""
    events = 0
    previous_trace = sys.gettrace()

    def trace(frame, event, arg):
        nonlocal events
        if frame.f_code is split_text_into_chunks.__code__ and event == "line":
            events += 1
            if events > 2000:
                raise AssertionError("Text chunker did not make forward progress")
        return trace

    sys.settrace(trace)
    try:
        return split_text_into_chunks(text, chunk_size, overlap)
    finally:
        sys.settrace(previous_trace)


def test_sentence_boundary_shorter_than_overlap_does_not_stall():
    text = "abcd. efghijklmnopqrstuvwxyz"
    chunks = split_with_progress_guard(text, chunk_size=10, overlap=8)

    assert chunks[0] == text[:10]
    assert chunks[-1].endswith("z")
    assert all(0 < len(chunk) <= 10 for chunk in chunks)
    assert len(chunks) <= len(text)
    assert chunks == [text[start:start + 10].strip() for start in range(0, 20, 2)]


def test_sentence_boundary_equal_to_overlap_does_not_stall():
    text = "abcd. efghijklmnop"
    chunks = split_with_progress_guard(text, chunk_size=10, overlap=6)

    assert chunks[0] == text[:10]
    assert chunks[-1].endswith("p")


def test_normal_sentence_boundaries_are_preserved():
    assert split_text_into_chunks("hello. world here", chunk_size=10, overlap=2) == [
        "hello.", ". world he", "here"
    ]


@pytest.mark.parametrize("chunk_size", [0, -1, 1.5, True, "10"])
def test_invalid_chunk_size_is_rejected(chunk_size):
    with pytest.raises(ValueError, match="chunk_size"):
        split_with_progress_guard("short text", chunk_size=chunk_size, overlap=0)


@pytest.mark.parametrize("overlap", [-1, 10, 11, 1.5, True, "1"])
def test_invalid_overlap_is_rejected(overlap):
    with pytest.raises(ValueError, match="overlap"):
        split_with_progress_guard("short text", chunk_size=10, overlap=overlap)


def test_zero_overlap_and_empty_text():
    assert split_text_into_chunks("abcdefg", chunk_size=3, overlap=0) == ["abc", "def", "g"]
    assert split_text_into_chunks("   ", chunk_size=3, overlap=0) == []
    assert split_text_into_chunks("", chunk_size=3, overlap=0) == []
