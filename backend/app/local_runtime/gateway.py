"""Bounded, loopback-only OpenAI transport shared by backend and child processes.

Constructing settings or importing this module performs no network I/O. Start one
instance in the owning backend and give every worker its returned /v1 URL. This
bounds *gateway requests*; a model server may keep computing after a cancellation.
Client disconnects retain their slot until completion or the request deadline;
they do not cause immediate cancellation of the upstream model request.
No remote fallback, redirects, environment proxies, credentials, or prompt logs.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
from dataclasses import dataclass
from http.cookiejar import CookieJar, DefaultCookiePolicy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import math
import re
import socket
import threading
import time
from urllib.parse import urlsplit, urlunsplit

import httpx


MAX_REQUEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024


def validate_loopback_url(url: str, schemes=("http", "https")) -> str:
    """Validate without DNS; canonicalize localhost to the IPv4 loopback literal.

    Alternate protocols, such as bolt, must be explicitly allowed by the caller.
    Ambiguous numeric IPs, credentials, scopes, escaped paths and URL parameters
    are deliberately rejected instead of relying on a transport's interpretation.
    """
    if not isinstance(url, str) or not url or any(char.isspace() or ord(char) < 32 for char in url):
        raise ValueError("A literal loopback URL is required")
    if any(char in url for char in ("\\", "?", "#", "%")):
        raise ValueError("Loopback URLs cannot contain escapes, queries or fragments")
    try:
        parts = urlsplit(url)
        if parts.scheme not in tuple(schemes) or not parts.netloc or parts.username is not None:
            raise ValueError("Invalid loopback URL scheme or authority")
        hostname = parts.hostname
        port = parts.port
        if not hostname or parts.netloc.endswith(":") or port is not None and not 1 <= port <= 65535:
            raise ValueError("Invalid loopback URL host or port")
        if hostname.lower() == "localhost":
            host = "127.0.0.1"
        else:
            address = ipaddress.ip_address(hostname)
            if not address.is_loopback or getattr(address, "ipv4_mapped", None) is not None:
                raise ValueError("Only literal loopback IP addresses are allowed")
            host = f"[{address.compressed}]" if address.version == 6 else address.compressed
        if not re.fullmatch(r"(?:/[A-Za-z0-9._~-]*)*", parts.path):
            raise ValueError("Invalid loopback URL path")
        if any(segment in (".", "..") for segment in parts.path.split("/")) or "//" in parts.path:
            raise ValueError("Ambiguous loopback URL path")
        authority = host if port is None else f"{host}:{port}"
        return urlunsplit((parts.scheme, authority, parts.path.rstrip("/"), "", ""))
    except (TypeError, ValueError) as exc:
        raise ValueError("A valid literal loopback URL is required") from exc


@dataclass(frozen=True)
class GatewaySettings:
    llm_base_url: str
    embedding_base_url: str
    max_concurrency: int = 1
    max_queue: int = 32
    request_timeout: float = 180.0
    max_output_tokens: int = 2048
    max_input_chars: int = 24000
    reasoning_effort: str | None = None

    def __post_init__(self):
        for name in ("max_concurrency", "max_output_tokens", "max_input_chars", "max_queue"):
            value = getattr(self, name)
            if type(value) is not int or value < (0 if name == "max_queue" else 1):
                raise ValueError(f"{name} must be a {'nonnegative' if name == 'max_queue' else 'positive'} integer")
        if (isinstance(self.request_timeout, bool) or not isinstance(self.request_timeout, (int, float))
                or not math.isfinite(self.request_timeout) or self.request_timeout <= 0):
            raise ValueError("request_timeout must be a finite positive number")
        if self.reasoning_effort is not None:
            if not isinstance(self.reasoning_effort, str) or not self.reasoning_effort.strip():
                raise ValueError("reasoning_effort must be None or a nonempty string")
            object.__setattr__(self, "reasoning_effort", self.reasoning_effort.strip())
        for name in ("llm_base_url", "embedding_base_url"):
            normalized = validate_loopback_url(getattr(self, name))
            # A base URL names the OpenAI API root, never an arbitrary proxy path.
            if urlsplit(normalized).path not in ("", "/v1"):
                raise ValueError(f"{name} must use the root or /v1 API path")
            object.__setattr__(self, name, normalized)


class _GatewayError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


def _error_body(message):
    return json.dumps({"error": {"message": message, "type": "local_gateway_error"}}).encode()


def _input_size(value):
    if isinstance(value, str):
        return len(value)
    if isinstance(value, dict):
        return sum(len(key) + _input_size(item) for key, item in value.items())
    if isinstance(value, list):
        return sum(_input_size(item) for item in value)
    return 1


def _prepare_payload(path, payload, settings):
    if not isinstance(payload, dict):
        raise _GatewayError(400, "A JSON object is required")
    model = payload.get("model")
    if not isinstance(model, str) or not model.strip():
        raise _GatewayError(400, "A nonempty local model name is required")
    if model.strip().lower().endswith((":cloud", "-cloud")):
        raise _GatewayError(400, "Cloud model routes are forbidden by the local gateway")
    payload["model"] = model.strip()
    if payload.get("stream", False) is not False:
        raise _GatewayError(400, "Streaming is not supported by the bounded local gateway")
    if path == "/v1/chat/completions":
        if settings.reasoning_effort is not None:
            payload["reasoning_effort"] = settings.reasoning_effort
            if "reasoning" in payload:
                if not isinstance(payload["reasoning"], dict):
                    raise _GatewayError(400, "Nested reasoning settings must be an object")
                payload["reasoning"]["effort"] = settings.reasoning_effort
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages or not all(isinstance(m, dict) for m in messages):
            raise _GatewayError(400, "A nonempty messages array is required")
        for message in messages:
            content = message.get("content")
            if isinstance(content, list):
                if not all(isinstance(part, dict) and part.get("type") == "text"
                           and isinstance(part.get("text"), str) for part in content):
                    raise _GatewayError(400, "Only text message content is supported")
            elif content is not None and not isinstance(content, str):
                raise _GatewayError(400, "Only text message content is supported")
        if "n" in payload and (type(payload["n"]) is not int or payload["n"] != 1):
            raise _GatewayError(400, "Only a single completion is supported")
        token_fields = [name for name in ("max_tokens", "max_completion_tokens") if name in payload]
        for name in token_fields:
            value = payload[name]
            if type(value) is not int or value <= 0:
                raise _GatewayError(400, "Token limits must be positive integers")
            payload[name] = min(value, settings.max_output_tokens)
        if not token_fields:
            payload["max_tokens"] = settings.max_output_tokens
    else:
        value = payload.get("input")
        # Support text and OpenAI token-ID arrays, but bound both aggregate sizes.
        valid = isinstance(value, str) or (
            isinstance(value, list) and bool(value) and (
                all(isinstance(item, str) for item in value)
                or all(type(item) is int and item >= 0 for item in value)
                or all(isinstance(item, list) and bool(item)
                       and all(type(token) is int and token >= 0 for token in item) for item in value)
            )
        )
        if not valid:
            raise _GatewayError(400, "A text or token input is required")
    if _input_size(payload) > settings.max_input_chars:
        raise _GatewayError(413, "Input exceeds the configured local context budget")
    return payload


class _BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = False

    def __init__(self, gateway):
        self.gateway = gateway
        self.admission = threading.BoundedSemaphore(gateway.settings.max_concurrency + gateway.settings.max_queue)
        self.connections = set()
        self.connections_lock = threading.Lock()
        super().__init__(("127.0.0.1", 0), _Handler)

    def process_request(self, request, client_address):
        if not self.admission.acquire(blocking=False):
            body = _error_body("Local inference queue is full; retry later")
            response = (f"HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\n"
                        f"Content-Length: {len(body)}\r\nRetry-After: 1\r\nConnection: close\r\n\r\n").encode() + body
            try:
                request.settimeout(0.1)
                request.sendall(response)
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        with self.connections_lock:
            self.connections.add(request)
        try:
            super().process_request(request, client_address)
        except BaseException:
            with self.connections_lock:
                self.connections.discard(request)
            self.admission.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            with self.connections_lock:
                self.connections.discard(request)
            self.admission.release()

    def close_connections(self):
        with self.connections_lock:
            connections = list(self.connections)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()

    def handle_error(self, request, client_address):
        # Base implementation writes exceptions to stderr, potentially with data.
        pass


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # One request per admitted socket; no keepalive bypass.

    def setup(self):
        super().setup()
        self.deadline = time.monotonic() + self.server.gateway.settings.request_timeout
        self.connection.settimeout(self.server.gateway.settings.request_timeout)
        # A drip-fed request line/header cannot hold a worker indefinitely.
        self.header_timer = threading.Timer(self.server.gateway.settings.request_timeout, self._expire_headers)
        self.header_timer.daemon = True
        self.header_timer.start()

    def _expire_headers(self):
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def parse_request(self):
        try:
            return super().parse_request()
        finally:
            self.header_timer.cancel()

    def finish(self):
        self.header_timer.cancel()
        super().finish()

    def log_message(self, *_args):
        pass

    def send_error(self, code, message=None, explain=None):
        # Never echo a request path, supplied HTTP method, or parser exception.
        self._reply(code, _error_body("Unsupported or malformed gateway request"))

    def _reply(self, status, body):
        try:
            # Upstream work already spent part of the admission lifetime. A
            # slow reader must not receive a fresh full timeout for each write.
            self.connection.settimeout(max(0.001, self.deadline - time.monotonic()))
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            if status == 429:
                self.send_header("Retry-After", "1")
            self.end_headers()
            if self.command != "HEAD":
                self.connection.settimeout(max(0.001, self.deadline - time.monotonic()))
                self.wfile.write(body)
        except OSError:
            pass
        self.close_connection = True

    def do_GET(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def do_DELETE(self):
        self.send_error(405)

    do_PUT = do_DELETE
    do_PATCH = do_DELETE
    do_HEAD = do_DELETE
    do_OPTIONS = do_DELETE
    do_CONNECT = do_DELETE
    do_TRACE = do_DELETE

    def _read_payload(self):
        if self.headers.get("Transfer-Encoding") is not None:
            raise _GatewayError(400, "Chunked request bodies are not supported")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not lengths[0].isdigit():
            raise _GatewayError(400, "A valid Content-Length is required")
        length = int(lengths[0])
        if length > MAX_REQUEST_BYTES:
            raise _GatewayError(413, "Request body is too large")
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise _GatewayError(415, "An application/json request is required")
        data = bytearray()
        while len(data) < length:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise _GatewayError(408, "Request body timed out")
            self.connection.settimeout(remaining)
            chunk = self.rfile.read1(min(65536, length - len(data)))
            if not chunk:
                raise _GatewayError(400, "Incomplete request body")
            data.extend(chunk)
        try:
            return json.loads(data, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError, RecursionError):
            raise _GatewayError(400, "A valid JSON request is required") from None

    def _dispatch(self):
        try:
            # SDK-only listener: reject cross-origin browser requests and DNS
            # rebinding before parsing a payload or consuming model resources.
            hosts = self.headers.get_all("Host", [])
            allowed_hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            if len(hosts) != 1 or hosts[0].lower() not in allowed_hosts or "Origin" in self.headers:
                raise _GatewayError(403, "Only direct local SDK requests are accepted")
            allowed = {"/v1/chat/completions": "POST", "/v1/embeddings": "POST",
                       "/v1/models": "GET", "/health": "GET"}
            if self.path not in allowed:
                raise _GatewayError(404, "Unknown local gateway endpoint")
            if self.command != allowed[self.path]:
                raise _GatewayError(405, "Unsupported method for local gateway endpoint")
            if self.path == "/health":
                self._reply(200, b'{"status":"ok","service":"local-inference-gateway"}')
                return
            gateway = self.server.gateway
            payload = _prepare_payload(self.path, self._read_payload(), gateway.settings) if self.command == "POST" else None
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise _GatewayError(408, "Request body timed out")
            future = asyncio.run_coroutine_threadsafe(gateway._forward(self.path, payload, remaining), gateway._loop)
            try:
                status, body = future.result(timeout=remaining + 0.25)
            except concurrent.futures.TimeoutError:
                future.cancel()
                raise _GatewayError(504, "Local inference request timed out") from None
            except concurrent.futures.CancelledError:
                raise _GatewayError(503, "Local inference gateway is shutting down") from None
            self._reply(status, body)
        except _GatewayError as exc:
            self._reply(exc.status, _error_body(exc.message))
        except (TimeoutError, socket.timeout):
            self._reply(408, _error_body("Request body timed out"))
        except (OSError, ValueError, RecursionError, RuntimeError):
            self._reply(400, _error_body("Invalid or interrupted local gateway request"))


class LocalInferenceGateway:
    """An explicit-lifecycle, process-shared local inference budget."""

    def __init__(self, settings: GatewaySettings):
        self.settings = settings
        self._lock = threading.Lock()
        self._closed = False
        self._server = None
        self._loop = None
        self._client = None
        self._base_url = None

    async def _initialize(self):
        self._budget = asyncio.Semaphore(self.settings.max_concurrency)
        self._client = httpx.AsyncClient(
            trust_env=False, follow_redirects=False,
            # Cookie domains ignore TCP ports. Never retain model-server cookies,
            # even when chat and embedding servers run on the same loopback IP.
            cookies=CookieJar(policy=DefaultCookiePolicy(allowed_domains=[])),
            headers={"Authorization": "Bearer local", "Accept": "application/json", "Accept-Encoding": "identity"},
            limits=httpx.Limits(max_connections=self.settings.max_concurrency,
                               max_keepalive_connections=self.settings.max_concurrency),
            timeout=self.settings.request_timeout,
        )

    def start(self) -> str:
        with self._lock:
            if self._closed:
                raise RuntimeError("A closed local inference gateway cannot be restarted")
            if self._server is not None:
                return self._base_url
            self._loop = asyncio.new_event_loop()
            self._loop_thread = threading.Thread(target=self._loop.run_forever, name="local-inference-io", daemon=True)
            self._loop_thread.start()
            try:
                asyncio.run_coroutine_threadsafe(self._initialize(), self._loop).result(timeout=5)
                self._server = _BoundedHTTPServer(self)
                self._base_url = f"http://127.0.0.1:{self._server.server_port}/v1"
                self._server_thread = threading.Thread(target=self._server.serve_forever,
                                                       kwargs={"poll_interval": 0.05},
                                                       name="local-inference-http", daemon=True)
                self._server_thread.start()
            except BaseException:
                if self._client is not None:
                    asyncio.run_coroutine_threadsafe(self._client.aclose(), self._loop).result(timeout=5)
                self._loop.call_soon_threadsafe(self._loop.stop)
                self._loop_thread.join(5)
                self._loop.close()
                raise
            return self._base_url

    async def _forward(self, path, payload, remaining):
        base = self.settings.embedding_base_url if path == "/v1/embeddings" else self.settings.llm_base_url
        url = base.rstrip("/") + ("/v1" if not urlsplit(base).path else "") + path.removeprefix("/v1")
        try:
            async with asyncio.timeout(remaining):
                async with self._budget:
                    async with self._client.stream("POST" if payload is not None else "GET", url, json=payload) as response:
                        if not 200 <= response.status_code < 300:
                            raise _GatewayError(502, "Local model server rejected the request")
                        if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                            raise _GatewayError(502, "Compressed local model responses are unsupported")
                        if response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                            raise _GatewayError(502, "Local model server returned an unsupported response")
                        declared = response.headers.get("Content-Length")
                        if declared is not None and (not declared.isdigit() or int(declared) > MAX_RESPONSE_BYTES):
                            raise _GatewayError(502, "Local model response is too large")
                        body = bytearray()
                        async for chunk in response.aiter_raw():
                            if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                                raise _GatewayError(502, "Local model response is too large")
                            body.extend(chunk)
                        try:
                            json.loads(body, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                        except (ValueError, UnicodeError, RecursionError):
                            raise _GatewayError(502, "Local model server returned invalid JSON") from None
                        return response.status_code, bytes(body)
        except (TimeoutError, httpx.TimeoutException):
            raise _GatewayError(504, "Local inference request timed out") from None
        except httpx.HTTPError:
            raise _GatewayError(502, "Local model server is unavailable") from None

    async def _shutdown(self):
        tasks = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self._client.aclose()

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self._server is None:
                return
            self._server.shutdown()
            self._server.server_close()
            self._server.close_connections()
            self._server_thread.join(5)
            try:
                asyncio.run_coroutine_threadsafe(self._shutdown(), self._loop).result(timeout=5)
            finally:
                self._loop.call_soon_threadsafe(self._loop.stop)
                self._loop_thread.join(5)
                self._loop.close()
