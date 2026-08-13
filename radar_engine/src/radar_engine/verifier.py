from __future__ import annotations

import html
import ipaddress
import re
import socket
import ssl
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Protocol
from urllib.parse import urlparse
from urllib.error import URLError
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from .models import AccessState, EvidenceCandidate, EvidenceVerification


class EvidenceVerifier(Protocol):
    def verify(self, evidence: EvidenceCandidate) -> EvidenceVerification: ...


def _normalize(value: str | None) -> str:
    if not value:
        return ""
    value = html.unescape(value).casefold()
    return re.sub(r"[^\w\u4e00-\u9fff]+", "", value)


def _bigrams(value: str) -> set[str]:
    if len(value) < 2:
        return {value} if value else set()
    return {value[index : index + 2] for index in range(len(value) - 1)}


def _similar(left: str | None, right: str | None, threshold: float = 0.45) -> bool:
    left_normal = _normalize(left)
    right_normal = _normalize(right)
    if not left_normal or not right_normal:
        return False
    if left_normal in right_normal or right_normal in left_normal:
        return True
    left_pairs = _bigrams(left_normal)
    right_pairs = _bigrams(right_normal)
    union = left_pairs | right_pairs
    return bool(union) and len(left_pairs & right_pairs) / len(union) >= threshold


class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.in_title = False
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.meta: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = {key.lower(): value or "" for key, value in attrs}
        if tag.lower() == "title":
            self.in_title = True
        if tag.lower() == "meta":
            key = (attrs_map.get("property") or attrs_map.get("name") or "").lower()
            content = attrs_map.get("content", "")
            if key and content:
                self.meta[key] = content

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        cleaned = data.strip()
        if not cleaned:
            return
        if self.in_title:
            self.title_parts.append(cleaned)
        if len(" ".join(self.text_parts)) < 200_000:
            self.text_parts.append(cleaned)

    @property
    def title(self) -> str:
        return self.meta.get("og:title") or " ".join(self.title_parts)

    @property
    def date(self) -> str | None:
        for key in (
            "article:published_time",
            "og:published_time",
            "datepublished",
            "publishdate",
            "pubdate",
            "date",
        ):
            if self.meta.get(key):
                return self.meta[key]
        return None

    @property
    def searchable_text(self) -> str:
        return " ".join(
            [
                self.title,
                self.meta.get("description", ""),
                self.meta.get("og:description", ""),
                " ".join(self.text_parts),
            ]
        )


def _is_public_host(hostname: str) -> bool:
    if hostname.casefold() in {"localhost", "localhost.localdomain"}:
        return False
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(hostname, None)}
    except socket.gaierror:
        return False
    if not addresses:
        return False
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            return False
    return True


class _SafeRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        hostname = urlparse(newurl).hostname
        if not hostname or not _is_public_host(hostname):
            raise URLError("重定向目标不是公开地址")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


@dataclass
class HttpEvidenceVerifier:
    timeout_seconds: float = 12.0
    max_bytes: int = 750_000
    user_agent: str = "XunchaRadarEvidenceVerifier/0.1"

    def verify(self, evidence: EvidenceCandidate) -> EvidenceVerification:
        parsed = urlparse(evidence.url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return EvidenceVerification(
                url=evidence.url,
                access=AccessState.INVALID,
                reason="只允许核验公开 HTTP(S) URL",
            )
        if not _is_public_host(parsed.hostname):
            return EvidenceVerification(
                url=evidence.url,
                access=AccessState.INVALID,
                reason="URL 指向本地、私网或无法解析的地址",
            )
        request = Request(
            evidence.url,
            headers={
                "User-Agent": self.user_agent,
                "Accept": "text/html,application/xhtml+xml",
            },
        )
        try:
            opener = build_opener(
                _SafeRedirectHandler(),
                HTTPSHandler(context=ssl.create_default_context()),
            )
            with opener.open(request, timeout=self.timeout_seconds) as response:
                final_url = response.geturl()
                final_host = urlparse(final_url).hostname
                if not final_host or not _is_public_host(final_host):
                    return EvidenceVerification(
                        url=evidence.url,
                        access=AccessState.INVALID,
                        final_url=final_url,
                        reason="重定向目标不是公开地址",
                    )
                status = response.getcode()
                content_type = response.headers.get("Content-Type", "")
                body = response.read(self.max_bytes)
        except Exception as exc:  # 网络和站点限制统一转为可审计失败，不伪装成功
            return EvidenceVerification(
                url=evidence.url,
                access=AccessState.INACCESSIBLE,
                reason=f"{type(exc).__name__}: {exc}",
            )
        if not 200 <= status < 300:
            return EvidenceVerification(
                url=evidence.url,
                access=AccessState.INACCESSIBLE,
                final_url=final_url,
                http_status=status,
                reason=f"HTTP {status}",
            )
        if "html" not in content_type.casefold():
            return EvidenceVerification(
                url=evidence.url,
                access=AccessState.PARTIAL,
                final_url=final_url,
                http_status=status,
                reason=f"不支持自动核验的内容类型: {content_type}",
            )

        text = body.decode("utf-8", errors="replace")
        parser = _PageParser()
        parser.feed(text)
        title_match = _similar(evidence.title, parser.title)
        content_match = _similar(evidence.excerpt, parser.searchable_text, threshold=0.25)
        date_match = bool(
            evidence.published_at
            and parser.date
            and evidence.published_at[:10] == parser.date[:10]
        )
        access = (
            AccessState.VERIFIED
            if title_match and content_match and date_match
            else AccessState.PARTIAL
        )
        return EvidenceVerification(
            url=evidence.url,
            access=access,
            final_url=final_url,
            http_status=status,
            title_match=title_match,
            date_match=date_match,
            content_match=content_match,
            observed_title=parser.title or None,
            observed_date=parser.date,
            reason=None if access is AccessState.VERIFIED else "标题、日期或内容未全部一致",
        )


@dataclass
class FixtureVerifier:
    results: dict[str, EvidenceVerification]

    def verify(self, evidence: EvidenceCandidate) -> EvidenceVerification:
        return self.results.get(
            evidence.url,
            EvidenceVerification(
                url=evidence.url,
                access=AccessState.FAILED,
                reason="fixture 未提供核验结果",
            ),
        )
