"""
URL 安全校验：防止 SSRF，禁止请求内网/回环/元数据地址。
供 board_api、knowledge_api 等复用。
"""
import os
import socket
import ipaddress
from urllib.parse import urlparse

_ALLOWED_PORTS = (80, 443)


def _resolve_host_to_ip(host: str) -> str | None:
    """解析 host 为 IP，失败返回 None。"""
    try:
        family, _, _, _, sockaddr = socket.getaddrinfo(host, None, socket.AF_UNSPEC)[0]
        if family == socket.AF_INET:
            return sockaddr[0]
        if family == socket.AF_INET6:
            addr = sockaddr[0]
            if addr.startswith("::ffff:"):
                return addr.replace("::ffff:", "")
            return addr
    except (socket.gaierror, IndexError, OSError):
        pass
    return None


def _ip_is_forbidden(addr_str: str) -> bool:
    """判断 IP 是否为禁止访问的地址（私有/回环/保留/链路本地/未指定）。"""
    try:
        addr = ipaddress.ip_address(addr_str)
        return (
            addr.is_private
            or addr.is_loopback
            or addr.is_reserved
            or addr.is_link_local
            or addr.is_unspecified
        )
    except ValueError:
        return True


def _try_parse_ip(s: str) -> bool:
    try:
        ipaddress.ip_address(s.strip())
        return True
    except ValueError:
        return False


def is_safe_callback_url(url: str) -> bool:
    """
    校验 URL 仅允许 https，且禁止私有/loopback/保留/链路本地地址，防止 SSRF。
    仅允许端口 80/443；数字 IP 与域名均需在 SAFE_CALLBACK_HOSTS 白名单内；
    域名会做 DNS 解析并二次校验解析后 IP 非内网，防 DNS 重绑定。
    """
    try:
        parsed = urlparse(url)
        scheme = (parsed.scheme or "").lower()
        if scheme != "https":
            return False
        host = (parsed.hostname or "").strip()
        if not host:
            return False
        port = parsed.port
        if port is None:
            port = 443 if scheme == "https" else 80
        if port not in _ALLOWED_PORTS:
            return False

        whitelist_raw = os.environ.get("SAFE_CALLBACK_HOSTS", "").strip()
        allowed_hosts = [h.strip().lower() for h in whitelist_raw.split(",") if h.strip()]

        try:
            addr = ipaddress.ip_address(host)
            if _ip_is_forbidden(host):
                return False
            allowed_ips = [h.strip() for h in allowed_hosts if _try_parse_ip(h)]
            if not any(ipaddress.ip_address(h).compressed == addr.compressed for h in allowed_ips):
                return False
            return True
        except ValueError:
            pass

        host_lower = host.lower()
        if host_lower not in allowed_hosts:
            return False
        resolved = _resolve_host_to_ip(host)
        if resolved is None or _ip_is_forbidden(resolved):
            return False
        return True
    except Exception:
        return False
