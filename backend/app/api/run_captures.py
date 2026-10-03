"""Explicit saved-run capture writes and independent, read-only observations."""

import json
import re

from flask import current_app, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from . import run_captures_bp
from ..services import run_captures as service
from ..services.simulation_manager import SimulationManager
from ..services.simulation_runner import SimulationRunner
from ..storage import StoragePathError, storage_path


MAX_REQUEST_BYTES = 16 * 1024
_CAPTURE_ID = re.compile(r"[0-9a-f]{32}")


def _response(payload, status=200):
    # Preserve escaped legacy Unicode without emitting nonstandard JSON or
    # relying on a browser's handling of invalid UTF-8 sequences.
    response = current_app.response_class(
        json.dumps(payload, ensure_ascii=True, allow_nan=False, separators=(",", ":")),
        status=status, mimetype="application/json",
    )
    response.headers["Cache-Control"] = "no-store"
    return response


def _invalid():
    return _response({"success": False, "error_code": "invalid_request",
                      "error": "The run capture request is invalid."}, 400)


def _query(allowed, required=()):
    if any(key not in allowed or len(request.args.getlist(key)) != 1 for key in request.args):
        raise ValueError("Invalid query")
    if any(key not in request.args for key in required):
        raise ValueError("Missing query")
    return request.args.to_dict()


def _body(fields=frozenset({"simulation_id", "source_revision", "label", "note"})):
    if request.args or request.mimetype != "application/json":
        raise ValueError("Invalid request")
    if request.content_length is not None and request.content_length > MAX_REQUEST_BYTES:
        raise ValueError("Oversized body")
    body = request.stream.read(MAX_REQUEST_BYTES + 1)
    if len(body) > MAX_REQUEST_BYTES:
        raise ValueError("Oversized body")

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate key")
            result[key] = value
        return result

    def invalid_constant(_value):
        raise ValueError("Nonstandard JSON")

    value = json.loads(body.decode("utf-8"), object_pairs_hook=unique_object,
                       parse_constant=invalid_constant)
    if (type(value) is not dict
            or set(value) != fields
            or any(not isinstance(item, str) for item in value.values())):
        raise ValueError("Invalid capture fields")
    return value


def _root():
    return storage_path(current_app.config["UPLOAD_FOLDER"], "run_captures")


def _call(operation):
    try:
        data, status = operation()
        return _response({"success": True, "data": data}, status)
    except service.RunCaptureError as error:
        return _response({"success": False, "error_code": error.code,
                          "error": str(error)}, error.status_code)
    except StoragePathError:
        return _response({"success": False, "error_code": "unsafe_path",
                          "error": "The run capture storage path is unsafe."}, 400)
    except Exception:
        # Public responses contain no raw storage errors, paths or form text.
        return _response({"success": False, "error_code": "capture_unavailable",
                          "error": "The run capture could not be read or saved."}, 500)


@run_captures_bp.route("/preview", methods=["GET"])
def preview_run_capture():
    try:
        query = _query({"simulation_id"}, {"simulation_id"})
    except ValueError:
        return _invalid()
    return _call(lambda: (service.preview_saved_run(
        SimulationManager.SIMULATION_DATA_DIR, SimulationRunner.RUN_STATE_DIR,
        query["simulation_id"],
    ), 200))


@run_captures_bp.route("/records", methods=["GET"])
def list_run_captures():
    try:
        query = _query({"offset", "limit"})
        values = {}
        for key, default in (("offset", 0), ("limit", 20)):
            if key in query and re.fullmatch(r"[0-9]{1,3}", query[key]) is None:
                raise ValueError("Invalid page")
            values[key] = int(query[key]) if key in query else default
        if not 0 <= values["offset"] <= 500 or not 1 <= values["limit"] <= 50:
            raise ValueError("Invalid page")
    except ValueError:
        return _invalid()
    return _call(lambda: (service.list_run_captures(_root(), **values), 200))


@run_captures_bp.route("/records/<capture_id>", methods=["GET"])
def get_run_capture(capture_id):
    if request.args or _CAPTURE_ID.fullmatch(capture_id) is None:
        return _invalid()
    return _call(lambda: (service.get_run_capture(_root(), capture_id), 200))


@run_captures_bp.route("/records/<capture_id>", methods=["POST"])
def create_run_capture(capture_id):
    try:
        if _CAPTURE_ID.fullmatch(capture_id) is None:
            raise ValueError("Invalid capture ID")
        body = _body()
    except (ValueError, UnicodeDecodeError, RecursionError, BadRequest, RequestEntityTooLarge):
        return _invalid()

    def save():
        capture, created = service.create_run_capture(
            _root(), SimulationManager.SIMULATION_DATA_DIR, SimulationRunner.RUN_STATE_DIR,
            capture_id, **body,
        )
        return capture, 201 if created else 200
    return _call(save)


@run_captures_bp.route("/compare", methods=["GET"])
def compare_run_captures():
    try:
        query = _query({"left", "right"}, {"left", "right"})
        if (any(_CAPTURE_ID.fullmatch(value) is None for value in query.values())
                or query["left"] == query["right"]):
            raise ValueError("Invalid capture pair")
    except ValueError:
        return _invalid()
    return _call(lambda: (service.compare_run_captures(_root(), query["left"], query["right"]), 200))


@run_captures_bp.route("/recover", methods=["POST"])
def recover_run_capture_store():
    try:
        _body(frozenset())
    except (ValueError, UnicodeDecodeError, RecursionError, BadRequest, RequestEntityTooLarge):
        return _invalid()
    return _call(lambda: (service.recover_run_captures(_root()), 200))
