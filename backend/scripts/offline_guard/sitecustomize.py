"""Activated only by the explicit offline-test runner's child environment."""

import os

if os.environ.get("MIROFISH_OFFLINE_TESTS") == "1":
    from network_guard import install

    install()
