"""Cooperative cancellation signal for an explicitly owned local preparation."""


class PreparationCancelled(Exception):
    """Stop later preparation work without converting cancellation to a fallback."""

    def __init__(self):
        super().__init__("Local preparation was cancelled.")
