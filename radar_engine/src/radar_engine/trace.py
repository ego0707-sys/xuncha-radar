from __future__ import annotations

import datetime as dt
import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class TraceRecorder:
    """保存可审计的 Agent 轨迹，不记录密钥或完整网页正文。"""

    events: list[dict[str, Any]] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def record(self, event: str, **payload: Any) -> None:
        item = {
            "at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "event": event,
            "payload": payload,
        }
        with self._lock:
            self.events.append(item)

    def dump_jsonl(self, path: str | Path) -> str:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8") as handle:
            for event in self.events:
                handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")))
                handle.write("\n")
        return str(target.resolve())

