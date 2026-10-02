"""\n配置管理\n统一从项目根目录的 .env 文件加载配置\n"""

import os
import math
from dotenv import load_dotenv

# 加载项目根目录的 .env 文件
# 路径: MiroFish/.env (相对于 backend/app/config.py)
project_root_env = os.path.join(os.path.dirname(__file__), '../../.env')

if os.path.exists(project_root_env):
    load_dotenv(project_root_env, override=True)
else:
    # 如果根目录没有 .env，尝试加载环境变量（用于生产环境）
    load_dotenv(override=True)


def _numeric_env(name: str, default: str, kind):
    """Defer malformed local values to validation without echoing raw input.

    None is deliberately invalid, rather than silently applying a resource
    default. Cloud mode can still ignore unused local-only settings.
    """
    try:
        return kind(os.environ.get(name, default))
    except (ValueError, OverflowError):
        return None


class Config:
    """Flask配置类"""
    
    # Flask配置
    SECRET_KEY = os.environ.get('SECRET_KEY', 'mirofish-secret-key')
    DEBUG = os.environ.get('FLASK_DEBUG', 'False').lower() == 'true'
    
    # JSON配置 - 禁用ASCII转义，让中文直接显示
    JSON_AS_ASCII = False
    
    # Explicit local mode never falls back to a cloud provider.
    MEMORY_BACKEND = os.environ.get('MEMORY_BACKEND', 'zep').strip().lower()
    LOCAL_MODE = MEMORY_BACKEND == 'local'
    LLM_API_KEY = 'local' if LOCAL_MODE else os.environ.get('LLM_API_KEY')
    LLM_BASE_URL = os.environ.get('LLM_BASE_URL',
        'http://127.0.0.1:11434/v1' if LOCAL_MODE else 'https://api.openai.com/v1')
    LLM_MODEL_NAME = os.environ.get('LLM_MODEL_NAME',
        'mirofish-local' if LOCAL_MODE else 'gpt-4o-mini')
    LOCAL_EMBEDDING_BASE_URL = os.environ.get('LOCAL_EMBEDDING_BASE_URL', LLM_BASE_URL)
    LOCAL_EMBEDDING_MODEL = os.environ.get('LOCAL_EMBEDDING_MODEL', 'nomic-embed-text')
    LOCAL_EMBEDDING_DIMENSIONS = _numeric_env('LOCAL_EMBEDDING_DIMENSIONS', '768', int)
    LOCAL_GRAPH_URI = os.environ.get('LOCAL_GRAPH_URI', 'bolt://127.0.0.1:7687')
    LOCAL_GRAPH_USER = os.environ.get('LOCAL_GRAPH_USER', 'neo4j')
    LOCAL_GRAPH_PASSWORD = os.environ.get('LOCAL_GRAPH_PASSWORD', '')
    LOCAL_GRAPH_DATABASE = os.environ.get('LOCAL_GRAPH_DATABASE', 'neo4j')
    LOCAL_MAX_AGENT_ITERATIONS = _numeric_env('LOCAL_MAX_AGENT_ITERATIONS', '3', int)
    LOCAL_MAX_AGENTS = _numeric_env('LOCAL_MAX_AGENTS', '10', int)
    LOCAL_MAX_ROUNDS = _numeric_env('LOCAL_MAX_ROUNDS', '5', int)
    LOCAL_MAX_CONCURRENCY = _numeric_env('LOCAL_MAX_CONCURRENCY', '1', int)
    LOCAL_MAX_QUEUE = _numeric_env('LOCAL_MAX_QUEUE', '32', int)
    LOCAL_REQUEST_TIMEOUT = _numeric_env('LOCAL_REQUEST_TIMEOUT', '180', float)
    LOCAL_REASONING_EFFORT = os.environ.get('LOCAL_REASONING_EFFORT', 'none').strip() or None
    LOCAL_MAX_OUTPUT_TOKENS = _numeric_env('LOCAL_MAX_OUTPUT_TOKENS', '2048', int)
    LOCAL_CONTEXT_TOKENS = _numeric_env('LOCAL_CONTEXT_TOKENS', '8192', int)
    LOCAL_MAX_INPUT_CHARS = _numeric_env('LOCAL_MAX_INPUT_CHARS', '24000', int)
    
    # Zep配置
    ZEP_API_KEY = os.environ.get('ZEP_API_KEY')
    
    # 文件上传配置
    MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # 50MB
    UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), '../uploads')
    ALLOWED_EXTENSIONS = {'pdf', 'md', 'txt', 'markdown'}
    
    # 文本处理配置
    DEFAULT_CHUNK_SIZE = 500  # 默认切块大小
    DEFAULT_CHUNK_OVERLAP = 50  # 默认重叠大小
    
    # OASIS模拟配置
    OASIS_DEFAULT_MAX_ROUNDS = int(os.environ.get('OASIS_DEFAULT_MAX_ROUNDS', '10'))
    OASIS_SIMULATION_DATA_DIR = os.path.join(os.path.dirname(__file__), '../uploads/simulations')
    
    # OASIS平台可用动作配置
    OASIS_TWITTER_ACTIONS = [
        'CREATE_POST', 'LIKE_POST', 'REPOST', 'FOLLOW', 'DO_NOTHING', 'QUOTE_POST'
    ]
    OASIS_REDDIT_ACTIONS = [
        'LIKE_POST', 'DISLIKE_POST', 'CREATE_POST', 'CREATE_COMMENT',
        'LIKE_COMMENT', 'DISLIKE_COMMENT', 'SEARCH_POSTS', 'SEARCH_USER',
        'TREND', 'REFRESH', 'DO_NOTHING', 'FOLLOW', 'MUTE'
    ]
    
    # Report Agent配置
    REPORT_AGENT_MAX_TOOL_CALLS = int(os.environ.get('REPORT_AGENT_MAX_TOOL_CALLS', '5'))
    REPORT_AGENT_MAX_REFLECTION_ROUNDS = int(os.environ.get('REPORT_AGENT_MAX_REFLECTION_ROUNDS', '2'))
    REPORT_AGENT_TEMPERATURE = float(os.environ.get('REPORT_AGENT_TEMPERATURE', '0.5'))
    
    @classmethod
    def validate(cls) -> list[str]:
        """验证必要配置"""
        errors: list[str] = []
        if cls.MEMORY_BACKEND not in {'zep', 'local'}:
            errors.append("MEMORY_BACKEND must be 'zep' or 'local'")
        if cls.LOCAL_MODE:
            from .local_runtime.gateway import validate_loopback_url
            for name in ('LLM_BASE_URL', 'LOCAL_EMBEDDING_BASE_URL', 'LOCAL_GRAPH_URI'):
                try:
                    schemes = ('bolt',) if name == 'LOCAL_GRAPH_URI' else ('http', 'https')
                    validate_loopback_url(getattr(cls, name), schemes=schemes)
                except ValueError as exc:
                    errors.append(f"{name}: {exc}")
            for name in ('LOCAL_MAX_AGENT_ITERATIONS', 'LOCAL_MAX_AGENTS', 'LOCAL_MAX_ROUNDS', 'LOCAL_MAX_CONCURRENCY', 'LOCAL_MAX_QUEUE',
                         'LOCAL_MAX_OUTPUT_TOKENS', 'LOCAL_CONTEXT_TOKENS',
                         'LOCAL_MAX_INPUT_CHARS', 'LOCAL_EMBEDDING_DIMENSIONS'):
                value = getattr(cls, name)
                if type(value) is not int or value <= 0:
                    errors.append(f"{name} must be a positive integer")
            timeout = cls.LOCAL_REQUEST_TIMEOUT
            if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
                errors.append("LOCAL_REQUEST_TIMEOUT must be positive and finite")
            if (type(cls.LOCAL_MAX_OUTPUT_TOKENS) is int
                    and type(cls.LOCAL_CONTEXT_TOKENS) is int
                    and cls.LOCAL_MAX_OUTPUT_TOKENS >= cls.LOCAL_CONTEXT_TOKENS):
                errors.append("LOCAL_MAX_OUTPUT_TOKENS must be smaller than LOCAL_CONTEXT_TOKENS")
            if not cls.LLM_MODEL_NAME.strip() or not cls.LOCAL_EMBEDDING_MODEL.strip():
                errors.append("Local model names must not be empty")
        if not cls.LLM_API_KEY:
            errors.append("LLM_API_KEY 未配置")
        if not cls.LOCAL_MODE and not cls.ZEP_API_KEY:
            errors.append("ZEP_API_KEY 未配置")
        if not cls.LOCAL_MODE and os.environ.get("ZEP_API_URL"):
            errors.append("ZEP_API_URL 不受支持；MiroFish 仅连接 Zep Cloud")
        if cls.DEBUG:
            import warnings
            warnings.warn("Flask DEBUG mode is enabled. Do not use in production.", RuntimeWarning)
        return errors
