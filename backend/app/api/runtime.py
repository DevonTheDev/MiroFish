"""Passive runtime observations and explicitly requested local setup checks."""

from flask import jsonify, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from . import runtime_bp
from ..local_runtime.status import get_local_runtime_snapshot


def _response(payload, status=200):
    response = jsonify(payload)
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    return response


@runtime_bp.route("/status", methods=["GET"])
def runtime_status():
    if request.args:
        return _response({"success": False, "error_code": "invalid_query",
                          "error": "Runtime status does not accept query parameters"}, 400)
    try:
        return _response({"success": True, "data": get_local_runtime_snapshot()})
    except Exception:
        # No raw config, exception details, prompt data, or private paths.
        return _response({"success": False, "error_code": "runtime_status_unavailable",
                          "error": "Runtime status is unavailable"}, 500)


_READINESS_ERRORS = {
    "invalid_request": (400, "Local setup checks require an empty JSON object and no query parameters"),
    "local_mode_required": (403, "Local setup checks are available only in local mode"),
    "already_running": (409, "A local setup check is already running"),
    "run_not_found": (404, "This local setup check is no longer available"),
    "readiness_unavailable": (503, "Local setup checks are unavailable until the backend restarts"),
    "internal_failure": (500, "The local setup check is unavailable"),
}


def _readiness_error(code, snapshot=None):
    if code not in _READINESS_ERRORS:
        code = "internal_failure"
    status, message = _READINESS_ERRORS[code]
    payload = {"success": False, "error_code": code, "error": message}
    if code == "already_running" and snapshot is not None:
        payload["data"] = snapshot
    return _response(payload, status)


def _valid_readiness_request(*, action=False, run_id=None):
    if request.query_string:
        return False
    if run_id is not None:
        from uuid import UUID
        try:
            if len(run_id) != 36 or str(UUID(run_id)) != run_id:
                return False
        except (ValueError, AttributeError, TypeError):
            return False
    if not action:
        return True
    if request.mimetype != "application/json":
        return False
    # No caller-supplied model, endpoint, prompt, budget, or credentials. Bound
    # this read even when an intermediary did not supply Content-Length.
    if request.content_length is not None and request.content_length > 1024:
        return False
    try:
        import json
        body = request.stream.read(1025)
        if len(body) > 1024:
            return False
        def invalid_constant(_value):
            raise ValueError("Non-standard JSON constant")
        value = json.loads(body.decode("utf-8"), parse_constant=invalid_constant)
        return type(value) is dict and not value
    except (UnicodeDecodeError, ValueError, BadRequest, RequestEntityTooLarge):
        return False


def _readiness_call(method, *args, status=200):
    # Import only after the request boundary. The service itself keeps passive
    # reads free of manager construction, optional imports, and network probes.
    try:
        from ..local_runtime import readiness
    except Exception:
        return _readiness_error("internal_failure")
    try:
        data = getattr(readiness, method)(*args)
        return _response({"success": True, "data": data}, status)
    except readiness.ReadinessError as exc:
        return _readiness_error(exc.code, exc.snapshot)
    except Exception:
        return _readiness_error("internal_failure")


@runtime_bp.route("/readiness", methods=["GET"])
def local_readiness_status():
    if not _valid_readiness_request():
        return _readiness_error("invalid_request")
    return _readiness_call("get_readiness_snapshot")


@runtime_bp.route("/readiness", methods=["POST"])
def local_readiness_start():
    if not _valid_readiness_request(action=True):
        return _readiness_error("invalid_request")
    return _readiness_call("start_readiness_check", status=202)


@runtime_bp.route("/readiness/<run_id>/cancel", methods=["POST"])
def local_readiness_cancel(run_id):
    if not _valid_readiness_request(action=True, run_id=run_id):
        return _readiness_error("invalid_request")
    return _readiness_call("cancel_readiness_check", run_id)
