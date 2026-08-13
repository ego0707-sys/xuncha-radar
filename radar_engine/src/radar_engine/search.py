from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlencode
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class SearchItem:
    title: str
    url: str
    snippet: str
    published_at: str | None = None
    source: str | None = None


@dataclass(frozen=True)
class SearchResponse:
    query: str
    items: tuple[SearchItem, ...]
    provider: str
    transparent: bool = True

    def for_model(self, limit: int = 20) -> str:
        return json.dumps(
            {
                "query": self.query,
                "provider": self.provider,
                "result_count": len(self.items),
                "results": [
                    {
                        "title": item.title,
                        "url": item.url,
                        "snippet": item.snippet[:1200],
                        "published_at": item.published_at,
                        "source": item.source,
                    }
                    for item in self.items[:limit]
                ],
            },
            ensure_ascii=False,
        )


class SearchProvider(Protocol):
    def search(self, query: str) -> SearchResponse: ...


@dataclass
class SearxNGSearchProvider:
    """透明检索适配器：引擎能看到并审计每一条结果，而不是只让模型看到密文。"""

    endpoint: str
    api_key: str | None = None
    timeout_seconds: float = 30.0
    result_limit: int = 20

    def __post_init__(self) -> None:
        self.endpoint = self.endpoint.rstrip("/")
        if self.api_key is None:
            self.api_key = os.environ.get("SEARCH_API_KEY")

    def search(self, query: str) -> SearchResponse:
        params = urlencode(
            {
                "q": query,
                "format": "json",
                "language": "auto",
                "safesearch": "0",
            }
        )
        headers = {
            "Accept": "application/json",
            "User-Agent": "XunchaRadarSearch/0.1",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = Request(f"{self.endpoint}/search?{params}", headers=headers)
        with urlopen(request, timeout=self.timeout_seconds) as response:
            data = json.loads(response.read().decode("utf-8"))
        raw_results = data.get("results") or []
        items: list[SearchItem] = []
        for raw in raw_results[: self.result_limit]:
            title = str(raw.get("title") or "").strip()
            url = str(raw.get("url") or "").strip()
            if not title or not url:
                continue
            items.append(
                SearchItem(
                    title=title,
                    url=url,
                    snippet=str(raw.get("content") or "").strip(),
                    published_at=(
                        str(raw.get("publishedDate")).strip()
                        if raw.get("publishedDate")
                        else None
                    ),
                    source=str(raw.get("engine") or "").strip() or None,
                )
            )
        return SearchResponse(
            query=query,
            items=tuple(items),
            provider="searxng",
            transparent=True,
        )

