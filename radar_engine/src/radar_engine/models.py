from __future__ import annotations

import dataclasses
import datetime as dt
import enum
import json
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse


class ValidationError(ValueError):
    """模型提交或外部数据不符合引擎契约。"""


class PageRole(str, enum.Enum):
    DIRECT = "D"
    LEAD = "L"
    VERIFICATION = "V"
    BACKGROUND = "B"
    NOISE = "N"


class Grade(str, enum.Enum):
    A1 = "A1"
    A2 = "A2"
    B1 = "B1"
    B2 = "B2"
    B3 = "B3"
    C = "C"
    EXCLUDED = "EXCLUDED"


class Urgency(str, enum.Enum):
    IMMEDIATE = "immediate"
    TODAY = "today"
    OBSERVE = "observe"


class RunState(str, enum.Enum):
    COMPLETED_WITH_LEADS = "completed_with_effective_leads"
    COMPLETED_NO_LEAD = "completed_no_current_lead"
    SUPPLEMENTING = "supplementing_evidence"
    INCOMPLETE = "incomplete_coverage"
    FAILED = "failed"


class AccessState(str, enum.Enum):
    VERIFIED = "verified"
    PARTIAL = "partial"
    INACCESSIBLE = "inaccessible"
    INVALID = "invalid"
    FAILED = "failed"


SCORE_FIELDS = (
    "directness",
    "evidence_quality",
    "regulatory_match",
    "novelty",
    "domestic_connection",
)


def _require_text(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{key} 必须是非空字符串")
    return value.strip()


def _optional_text(data: dict[str, Any], key: str) -> str | None:
    value = data.get(key)
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValidationError(f"{key} 必须是字符串或 null")
    return value.strip() or None


def _validate_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValidationError(f"无效证据 URL: {url}")
    return url


@dataclass(frozen=True)
class DimensionScores:
    directness: int
    evidence_quality: int
    regulatory_match: int
    novelty: int
    domestic_connection: int

    def __post_init__(self) -> None:
        for name in SCORE_FIELDS:
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 3:
                raise ValidationError(f"{name} 必须是 0–3 的整数")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DimensionScores":
        if not isinstance(data, dict):
            raise ValidationError("dimensions 必须是对象")
        missing = [name for name in SCORE_FIELDS if name not in data]
        if missing:
            raise ValidationError(f"dimensions 缺少字段: {', '.join(missing)}")
        return cls(**{name: data[name] for name in SCORE_FIELDS})


@dataclass(frozen=True)
class RiskProposition:
    subject: str
    action: str
    content: str
    target: str
    propagation_mechanism: str
    possible_impact: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RiskProposition":
        if not isinstance(data, dict):
            raise ValidationError("proposition 必须是对象")
        return cls(
            subject=_require_text(data, "subject"),
            action=_require_text(data, "action"),
            content=_require_text(data, "content"),
            target=_require_text(data, "target"),
            propagation_mechanism=_require_text(data, "propagation_mechanism"),
            possible_impact=_require_text(data, "possible_impact"),
        )


@dataclass(frozen=True)
class EvidenceCandidate:
    url: str
    title: str
    platform: str
    published_at: str | None
    excerpt: str | None
    author: str | None
    role: PageRole
    dimensions: DimensionScores
    regulatory_basis: tuple[str, ...] = ()
    anchors: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EvidenceCandidate":
        if not isinstance(data, dict):
            raise ValidationError("evidence[] 必须是对象")
        regulatory_basis = data.get("regulatory_basis", [])
        anchors = data.get("anchors", [])
        if not isinstance(regulatory_basis, list) or not all(isinstance(x, str) for x in regulatory_basis):
            raise ValidationError("regulatory_basis 必须是字符串数组")
        if not isinstance(anchors, list) or not all(isinstance(x, str) for x in anchors):
            raise ValidationError("anchors 必须是字符串数组")
        try:
            role = PageRole(data.get("role"))
        except (ValueError, TypeError) as exc:
            raise ValidationError("role 必须是 D/L/V/B/N") from exc
        return cls(
            url=_validate_url(_require_text(data, "url")),
            title=_require_text(data, "title"),
            platform=_require_text(data, "platform"),
            published_at=_optional_text(data, "published_at"),
            excerpt=_optional_text(data, "excerpt"),
            author=_optional_text(data, "author"),
            role=role,
            dimensions=DimensionScores.from_dict(data.get("dimensions", {})),
            regulatory_basis=tuple(x.strip() for x in regulatory_basis if x.strip()),
            anchors=tuple(x.strip() for x in anchors if x.strip()),
        )


@dataclass(frozen=True)
class ThemeProposal:
    title: str
    summary: str
    proposition: RiskProposition
    urgency: Urgency
    evidence: tuple[EvidenceCandidate, ...]
    uncertainty: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ThemeProposal":
        if not isinstance(data, dict):
            raise ValidationError("themes[] 必须是对象")
        raw_evidence = data.get("evidence")
        if not isinstance(raw_evidence, list):
            raise ValidationError("evidence 必须是数组")
        raw_uncertainty = data.get("uncertainty", [])
        if not isinstance(raw_uncertainty, list) or not all(isinstance(x, str) for x in raw_uncertainty):
            raise ValidationError("uncertainty 必须是字符串数组")
        try:
            urgency = Urgency(data.get("urgency", Urgency.OBSERVE.value))
        except ValueError as exc:
            raise ValidationError("urgency 必须是 immediate/today/observe") from exc
        return cls(
            title=_require_text(data, "title"),
            summary=_require_text(data, "summary"),
            proposition=RiskProposition.from_dict(data.get("proposition", {})),
            urgency=urgency,
            evidence=tuple(EvidenceCandidate.from_dict(item) for item in raw_evidence),
            uncertainty=tuple(x.strip() for x in raw_uncertainty if x.strip()),
        )


@dataclass(frozen=True)
class CoverageReport:
    covered_lanes: tuple[str, ...]
    gaps: tuple[str, ...]
    stop_reason: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CoverageReport":
        if not isinstance(data, dict):
            raise ValidationError("coverage 必须是对象")
        lanes = data.get("covered_lanes", [])
        gaps = data.get("gaps", [])
        if not isinstance(lanes, list) or not all(isinstance(x, str) for x in lanes):
            raise ValidationError("covered_lanes 必须是字符串数组")
        if not isinstance(gaps, list) or not all(isinstance(x, str) for x in gaps):
            raise ValidationError("gaps 必须是字符串数组")
        return cls(
            covered_lanes=tuple(dict.fromkeys(x.strip() for x in lanes if x.strip())),
            gaps=tuple(x.strip() for x in gaps if x.strip()),
            stop_reason=_require_text(data, "stop_reason"),
        )


@dataclass(frozen=True)
class ResearchSubmission:
    task_summary: str
    coverage: CoverageReport
    themes: tuple[ThemeProposal, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ResearchSubmission":
        if not isinstance(data, dict):
            raise ValidationError("研究提交必须是 JSON 对象")
        raw_themes = data.get("themes")
        if not isinstance(raw_themes, list):
            raise ValidationError("themes 必须是数组")
        if len(raw_themes) > 20:
            raise ValidationError("单次提交不得超过 20 个候选主题")
        return cls(
            task_summary=_require_text(data, "task_summary"),
            coverage=CoverageReport.from_dict(data.get("coverage", {})),
            themes=tuple(ThemeProposal.from_dict(item) for item in raw_themes),
        )


@dataclass(frozen=True)
class EvidenceVerification:
    url: str
    access: AccessState
    final_url: str | None = None
    http_status: int | None = None
    title_match: bool = False
    date_match: bool = False
    content_match: bool = False
    observed_title: str | None = None
    observed_date: str | None = None
    reason: str | None = None


@dataclass(frozen=True)
class MaterialGate:
    passed: bool
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class ThemeResult:
    title: str
    summary: str
    proposition: RiskProposition
    grade: Grade
    urgency: Urgency
    evidence: tuple[EvidenceCandidate, ...]
    verifications: tuple[EvidenceVerification, ...]
    grade_reasons: tuple[str, ...]
    uncertainty: tuple[str, ...]


@dataclass(frozen=True)
class ToolHealth:
    model_api_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    search_attempts: int = 0
    search_successes: int = 0
    transparent_searches: int = 0
    opaque_searches: int = 0
    zero_result_searches: int = 0
    searched_lanes: tuple[str, ...] = ()
    tool_failures: tuple[str, ...] = ()
    duplicate_calls_blocked: int = 0
    submitted: bool = False
    exhausted_budget: bool = False


@dataclass(frozen=True)
class ResearchTask:
    prompt: str
    mode: str = "topic"
    now: str = field(default_factory=lambda: dt.datetime.now(dt.timezone.utc).isoformat())
    window_hours: int = 72
    max_searches: int = 12
    max_rounds: int = 8
    max_results: int = 10
    required_lanes: tuple[str, ...] = (
        "authority",
        "weak_signal",
        "source_tracing",
        "domestic_landing",
        "verification",
    )

    def __post_init__(self) -> None:
        if not self.prompt.strip():
            raise ValidationError("任务不能为空")
        if self.window_hours <= 0 or self.max_searches <= 0 or self.max_rounds <= 0:
            raise ValidationError("时间窗和预算必须为正数")
        if not 1 <= self.max_results <= 10:
            raise ValidationError("max_results 必须在 1–10 之间")


@dataclass(frozen=True)
class RunResult:
    run_id: str
    state: RunState
    state_reasons: tuple[str, ...]
    task: ResearchTask
    themes: tuple[ThemeResult, ...]
    coverage: CoverageReport | None
    tool_health: ToolHealth
    started_at: str
    finished_at: str
    trace_path: str | None = None


def to_jsonable(value: Any) -> Any:
    if dataclasses.is_dataclass(value):
        return {field.name: to_jsonable(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, tuple):
        return [to_jsonable(item) for item in value]
    if isinstance(value, list):
        return [to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    return value


def dumps(value: Any, *, indent: int = 2) -> str:
    return json.dumps(to_jsonable(value), ensure_ascii=False, indent=indent)
