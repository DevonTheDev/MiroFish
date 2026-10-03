"""
API路由模块
"""

from flask import Blueprint

graph_bp = Blueprint('graph', __name__)
simulation_bp = Blueprint('simulation', __name__)
report_bp = Blueprint('report', __name__)
runtime_bp = Blueprint('runtime', __name__)
run_captures_bp = Blueprint('run_captures', __name__)

from . import graph  # noqa: E402, F401
from . import simulation  # noqa: E402, F401
from . import report  # noqa: E402, F401
from . import runtime  # noqa: E402, F401
from . import prompt_trials  # noqa: E402, F401
from . import run_captures  # noqa: E402, F401
