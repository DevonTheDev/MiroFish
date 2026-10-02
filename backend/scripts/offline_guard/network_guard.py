"""Fail closed on non-loopback Python sockets during synthetic regression tests.

This is a regression guard, not an OS sandbox. Native code or non-Python child
processes require their own network isolation. Never use this as an app firewall.
"""

import ipaddress
import os
import socket


def _check_host(host):
    if isinstance(host, bytes):
        host = host.decode("ascii")
    if host is None or host == "localhost":
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except (ValueError, TypeError):
        pass
    raise RuntimeError("Offline tests permit only loopback network operations")


def _check_address(sock, address):
    if sock.family == getattr(socket, "AF_UNIX", None):
        return
    if not isinstance(address, tuple) or not address:
        raise RuntimeError("Offline tests require a loopback socket address")
    _check_host(address[0])


def install():
    """Install once, before pytest or any HTTP client is imported."""
    if getattr(socket, "_mirofish_offline_guard", False):
        return
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_sendto = socket.socket.sendto

    def connect(sock, address):
        _check_address(sock, address)
        return original_connect(sock, address)

    def connect_ex(sock, address):
        _check_address(sock, address)
        return original_connect_ex(sock, address)

    def sendto(sock, data, *args):
        _check_address(sock, args[-1] if args else None)
        return original_sendto(sock, data, *args)

    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    socket.socket.sendto = sendto
    if hasattr(socket.socket, "sendmsg"):
        original_sendmsg = socket.socket.sendmsg

        def sendmsg(sock, buffers, ancillary=(), flags=0, address=None):
            if address is not None:
                _check_address(sock, address)
                return original_sendmsg(sock, buffers, ancillary, flags, address)
            return original_sendmsg(sock, buffers, ancillary, flags)

        socket.socket.sendmsg = sendmsg
    # Prevent DNS egress before connect() can reject an address.
    for name in ("getaddrinfo", "gethostbyname", "gethostbyname_ex", "gethostbyaddr"):
        original = getattr(socket, name)

        def guarded(host, *args, _original=original, **kwargs):
            _check_host(host)
            return _original(host, *args, **kwargs)

        setattr(socket, name, guarded)
    original_getnameinfo = socket.getnameinfo

    def getnameinfo(address, flags):
        _check_host(address[0])
        return original_getnameinfo(address, flags)

    socket.getnameinfo = getnameinfo
    socket._mirofish_offline_guard = True
    os.environ["MIROFISH_OFFLINE_GUARD_ACTIVE"] = "1"
