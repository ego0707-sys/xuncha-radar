from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .models import RiskProposition, RunResult, ThemeResult, to_jsonable


TRACKING_PARAMS = {
    "fbclid",
    "gclid",
    "spm",
    "from",
    "source",
    "ref",
    "ref_src",
}


def canonical_url(url: str) -> str:
    parts = urlsplit(url)
    query = [
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in TRACKING_PARAMS
    ]
    return urlunsplit(
        (parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/") or "/", urlencode(query), "")
    )


def proposition_fingerprint(title: str, proposition: RiskProposition) -> str:
    basis = "|".join(
        [
            title,
            proposition.subject,
            proposition.action,
            proposition.propagation_mechanism,
        ]
    )
    normalized = re.sub(r"\s+", "", basis).casefold()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def theme_fingerprint(theme: ThemeResult) -> str:
    return proposition_fingerprint(theme.title, theme.proposition)


class SQLiteMemoryStore:
    """团队共享记忆的最小实现：历史主题、证据 URL、人工反馈。"""

    def __init__(self, path: str | Path = "artifacts/radar_memory.sqlite3") -> None:
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path)
        self.connection.row_factory = sqlite3.Row
        self._migrate()

    def _migrate(self) -> None:
        self.connection.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                state TEXT NOT NULL,
                task_prompt TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS themes (
                fingerprint TEXT NOT NULL,
                run_id TEXT NOT NULL,
                title TEXT NOT NULL,
                proposition TEXT NOT NULL,
                grade TEXT NOT NULL,
                urgency TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (fingerprint, run_id)
            );
            CREATE TABLE IF NOT EXISTS evidence (
                canonical_url TEXT NOT NULL,
                run_id TEXT NOT NULL,
                theme_fingerprint TEXT NOT NULL,
                title TEXT NOT NULL,
                platform TEXT NOT NULL,
                published_at TEXT,
                role TEXT NOT NULL,
                PRIMARY KEY (canonical_url, run_id)
            );
            CREATE TABLE IF NOT EXISTS feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                theme_fingerprint TEXT NOT NULL,
                label TEXT NOT NULL CHECK(label IN ('valuable','continue','false_positive','used_in_report')),
                note TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        self.connection.commit()

    def save_run(self, result: RunResult) -> None:
        payload = json.dumps(to_jsonable(result), ensure_ascii=False, separators=(",", ":"))
        with self.connection:
            self.connection.execute(
                "INSERT OR REPLACE INTO runs VALUES (?, ?, ?, ?, ?, ?)",
                (
                    result.run_id,
                    result.state.value,
                    result.task.prompt,
                    result.started_at,
                    result.finished_at,
                    payload,
                ),
            )
            for theme in result.themes:
                fingerprint = theme_fingerprint(theme)
                proposition = "；".join(
                    [
                        theme.proposition.subject,
                        theme.proposition.action,
                        theme.proposition.content,
                        theme.proposition.propagation_mechanism,
                    ]
                )
                self.connection.execute(
                    "INSERT OR REPLACE INTO themes VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        fingerprint,
                        result.run_id,
                        theme.title,
                        proposition,
                        theme.grade.value,
                        theme.urgency.value,
                        result.finished_at,
                    ),
                )
                for evidence in theme.evidence:
                    self.connection.execute(
                        "INSERT OR REPLACE INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            canonical_url(evidence.url),
                            result.run_id,
                            fingerprint,
                            evidence.title,
                            evidence.platform,
                            evidence.published_at,
                            evidence.role.value,
                        ),
                    )

    def recent_context(self, task_prompt: str, limit: int = 12) -> list[dict[str, Any]]:
        terms = set(re.findall(r"[\w\u4e00-\u9fff]{2,}", task_prompt.casefold()))
        rows = self.connection.execute(
            """
            SELECT t.*, f.label AS feedback_label
            FROM themes t
            LEFT JOIN feedback f ON f.theme_fingerprint = t.fingerprint
            ORDER BY t.created_at DESC
            LIMIT 100
            """
        ).fetchall()
        ranked: list[tuple[int, sqlite3.Row]] = []
        for row in rows:
            haystack = f"{row['title']} {row['proposition']}".casefold()
            overlap = sum(1 for term in terms if term in haystack)
            ranked.append((overlap, row))
        ranked.sort(key=lambda item: (item[0], item[1]["created_at"]), reverse=True)
        return [
            {
                "fingerprint": row["fingerprint"],
                "title": row["title"],
                "proposition": row["proposition"],
                "grade": row["grade"],
                "feedback": row["feedback_label"],
                "created_at": row["created_at"],
            }
            for _, row in ranked[:limit]
        ]

    def has_theme(self, fingerprint: str) -> bool:
        row = self.connection.execute(
            "SELECT 1 FROM themes WHERE fingerprint = ? LIMIT 1", (fingerprint,)
        ).fetchone()
        return row is not None

    def record_feedback(self, fingerprint: str, label: str, note: str | None = None) -> None:
        allowed = {"valuable", "continue", "false_positive", "used_in_report"}
        if label not in allowed:
            raise ValueError(f"反馈必须是以下之一: {', '.join(sorted(allowed))}")
        with self.connection:
            self.connection.execute(
                "INSERT INTO feedback(theme_fingerprint, label, note) VALUES (?, ?, ?)",
                (fingerprint, label, note),
            )

    def close(self) -> None:
        self.connection.close()
