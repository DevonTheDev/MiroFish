"""Read-only runtime observations; never probe or create runtime resources."""

from flask import jsonify, request

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
