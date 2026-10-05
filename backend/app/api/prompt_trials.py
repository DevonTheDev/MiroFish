"""Strict, same-origin browser boundary for explicitly requested prompt trials."""

from urllib.parse import urlsplit

from flask import jsonify, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from . import runtime_bp
from ..local_runtime.gateway import validate_loopback_url
from ..local_runtime.prompt_trials import (
    MAX_BODY_BYTES, MAX_CANCEL_BODY_BYTES, PromptTrialError as _InputError, _strict_json,
    normalize_cancellation, normalize_request, valid_uuid,
)


_ERRORS = {
    "invalid_request": (400, "The prompt trial request is invalid"),
    "local_browser_required": (403, "Prompt trials require a same-origin local browser request"),
    "local_mode_required": (403, "Prompt trials require local mode"),
    "already_running": (409, "A prompt trial is already running"),
    "request_conflict": (409, "This request ID already belongs to different inputs"),
    "run_not_found": (404, "This prompt trial is no longer available"),
    "trials_unavailable": (503, "Prompt trials are unavailable until the backend restarts"),
    "invalid_configuration": (503, "The loaded local model configuration is unavailable"),
    "internal_failure": (500, "The prompt trial is unavailable"),
}


def _response(payload, status=200):
    response = jsonify(payload)
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    return response


def _error(code, snapshot=None):
    if code not in _ERRORS:
        code = "internal_failure"
    status, message = _ERRORS[code]
    body = {"success": False, "error_code": code, "error": message}
    if code in ("already_running", "request_conflict") and snapshot is not None:
        body["data"] = snapshot
    return _response(body, status)


def _origin(value):
    # Validate literal loopback without DNS, but preserve localhost versus IP:
    # they are different browser origins even though both name this computer.
    validate_loopback_url(value)
    parts = urlsplit(value)
    if parts.path or parts.query or parts.fragment:
        raise ValueError
    return parts.scheme, parts.hostname.lower(), parts.port or (443 if parts.scheme == "https" else 80)


def _valid_browser():
    try:
        host = _origin(request.scheme + "://" + request.host)
        origin = request.headers.get("Origin")
        parsed = _origin(origin) if origin is not None else None
        site = request.headers.get("Sec-Fetch-Site")
        if site is not None:
            # Vite preserves Fetch Metadata/Origin and rewrites Host. Browser
            # same-origin metadata is authoritative for that supported proxy.
            return site in ("same-origin", "none")
        return parsed is None or parsed == host
    except (ValueError, TypeError, AttributeError):
        return False


def _boundary(request_id=None):
    if not _valid_browser():
        return _error("local_browser_required")
    if request.query_string or request_id is not None and not valid_uuid(request_id):
        return _error("invalid_request")
    return None


def _call(method, *args, status=200):
    try:
        from ..local_runtime import prompt_trials
        try:
            result = getattr(prompt_trials, method)(*args)
            return _response({"success": True, "data": result}, status)
        except prompt_trials.PromptTrialError as exc:
            return _error(exc.code, exc.snapshot)
    except Exception:
        pass
    return _error("internal_failure")


@runtime_bp.route("/trials", methods=["GET"])
def prompt_trials_latest():
    invalid = _boundary()
    return invalid if invalid is not None else _call("get_prompt_trials_snapshot")


@runtime_bp.route("/trials/<request_id>", methods=["GET"])
def prompt_trials_exact(request_id):
    invalid = _boundary(request_id)
    return invalid if invalid is not None else _call("get_prompt_trials_snapshot", request_id)


@runtime_bp.route("/trials", methods=["POST"])
def prompt_trials_start():
    invalid = _boundary()
    if invalid is not None:
        return invalid
    if (request.mimetype != "application/json"
            or request.content_length is not None and request.content_length > MAX_BODY_BYTES):
        return _error("invalid_request")
    try:
        raw = request.stream.read(MAX_BODY_BYTES + 1)
        if len(raw) > MAX_BODY_BYTES:
            return _error("invalid_request")
        value = normalize_request(_strict_json(raw))
    except (ValueError, UnicodeError, RecursionError, BadRequest, RequestEntityTooLarge, _InputError):
        return _error("invalid_request")
    return _call("start_prompt_trial", value, status=202)


@runtime_bp.route("/trials/<request_id>/cancel", methods=["POST"])
def prompt_trials_cancel(request_id):
    invalid = _boundary(request_id)
    if invalid is not None:
        return invalid
    if (request.mimetype != "application/json"
            or request.content_length is not None and request.content_length > MAX_CANCEL_BODY_BYTES):
        return _error("invalid_request")
    try:
        raw = request.stream.read(MAX_CANCEL_BODY_BYTES + 1)
        if len(raw) > MAX_CANCEL_BODY_BYTES:
            return _error("invalid_request")
        value = normalize_cancellation(_strict_json(raw))
    except (ValueError, UnicodeError, RecursionError, BadRequest, RequestEntityTooLarge, _InputError):
        return _error("invalid_request")
    return _call("cancel_prompt_trial", request_id, value, status=202)
