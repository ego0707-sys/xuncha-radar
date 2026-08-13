from __future__ import annotations

import dataclasses
import datetime as dt
import uuid
from pathlib import Path

from .agent import AgentError, ResearchAgent
from .grading import grade_theme, rank_and_limit
from .memory import SQLiteMemoryStore, proposition_fingerprint
from .models import (
    CoverageReport,
    DimensionScores,
    EvidenceCandidate,
    ResearchTask,
    RunResult,
    RunState,
    ThemeProposal,
    ToolHealth,
)
from .run_state import evaluate_run_state
from .trace import TraceRecorder
from .verifier import EvidenceVerifier


class RadarEngine:
    """编排研究 Agent、历史去重、证据核验、分级和运行状态。"""

    def __init__(
        self,
        agent: ResearchAgent,
        verifier: EvidenceVerifier,
        memory: SQLiteMemoryStore | None = None,
    ) -> None:
        self.agent = agent
        self.verifier = verifier
        self.memory = memory

    def _apply_memory_guard(self, proposal: ThemeProposal) -> ThemeProposal:
        if self.memory is None:
            return proposal
        fingerprint = proposition_fingerprint(proposal.title, proposal.proposition)
        if not self.memory.has_theme(fingerprint):
            return proposal
        guarded_evidence: list[EvidenceCandidate] = []
        for evidence in proposal.evidence:
            scores = evidence.dimensions
            guarded_evidence.append(
                dataclasses.replace(
                    evidence,
                    dimensions=DimensionScores(
                        directness=scores.directness,
                        evidence_quality=scores.evidence_quality,
                        regulatory_match=scores.regulatory_match,
                        novelty=min(scores.novelty, 1),
                        domestic_connection=scores.domestic_connection,
                    ),
                )
            )
        return dataclasses.replace(
            proposal,
            evidence=tuple(guarded_evidence),
            uncertainty=tuple(
                dict.fromkeys(
                    [*proposal.uncertainty, "团队历史记忆中已出现同一风险命题，本次不能按全新主题计分"]
                )
            ),
        )

    def run(
        self,
        task: ResearchTask,
        *,
        trace_path: str | Path | None = None,
    ) -> RunResult:
        run_id = f"radar-{uuid.uuid4().hex[:12]}"
        started_at = dt.datetime.now(dt.timezone.utc).isoformat()
        trace = TraceRecorder()
        memory_context = self.memory.recent_context(task.prompt) if self.memory else []

        try:
            outcome = self.agent.research(task, memory_context, trace)
        except AgentError as exc:
            trace.record("research_failed", error=str(exc))
            finished_at = dt.datetime.now(dt.timezone.utc).isoformat()
            stored_trace = trace.dump_jsonl(trace_path) if trace_path else None
            result = RunResult(
                run_id=run_id,
                state=RunState.FAILED,
                state_reasons=(str(exc),),
                task=task,
                themes=(),
                coverage=None,
                tool_health=ToolHealth(),
                started_at=started_at,
                finished_at=finished_at,
                trace_path=stored_trace,
            )
            if self.memory:
                self.memory.save_run(result)
            return result

        actual_lanes = set(outcome.health.searched_lanes)
        claimed_lanes = set(outcome.submission.coverage.covered_lanes)
        missing_required = [lane for lane in task.required_lanes if lane not in actual_lanes]
        false_claims = sorted(claimed_lanes - actual_lanes)
        coverage_gaps = list(outcome.submission.coverage.gaps)
        coverage_gaps.extend(f"未实际执行必要路径 {lane}" for lane in missing_required)
        coverage_gaps.extend(f"模型声称覆盖但轨迹中不存在：{lane}" for lane in false_claims)
        effective_coverage = CoverageReport(
            covered_lanes=tuple(lane for lane in task.required_lanes if lane in actual_lanes),
            gaps=tuple(dict.fromkeys(coverage_gaps)),
            stop_reason=outcome.submission.coverage.stop_reason,
        )

        graded = []
        for raw_proposal in outcome.submission.themes:
            proposal = self._apply_memory_guard(raw_proposal)
            verifications = []
            for evidence in proposal.evidence:
                trace.record(
                    "evidence_verification_started",
                    url=evidence.url,
                    role=evidence.role.value,
                )
                verification = self.verifier.verify(evidence)
                verifications.append(verification)
                trace.record(
                    "evidence_verification_finished",
                    url=evidence.url,
                    access=verification.access.value,
                    title_match=verification.title_match,
                    date_match=verification.date_match,
                    content_match=verification.content_match,
                    reason=verification.reason,
                )
            theme = grade_theme(proposal, tuple(verifications))
            graded.append(theme)
            trace.record(
                "theme_graded",
                title=theme.title,
                grade=theme.grade.value,
                reasons=list(theme.grade_reasons),
            )

        themes = rank_and_limit(graded, task.max_results)
        state, state_reasons = evaluate_run_state(
            effective_coverage,
            outcome.health,
            themes,
        )
        finished_at = dt.datetime.now(dt.timezone.utc).isoformat()
        trace.record(
            "run_finished",
            run_id=run_id,
            state=state.value,
            result_count=len(themes),
            reasons=list(state_reasons),
        )
        stored_trace = trace.dump_jsonl(trace_path) if trace_path else None
        result = RunResult(
            run_id=run_id,
            state=state,
            state_reasons=state_reasons,
            task=task,
            themes=themes,
            coverage=effective_coverage,
            tool_health=outcome.health,
            started_at=started_at,
            finished_at=finished_at,
            trace_path=stored_trace,
        )
        if self.memory:
            self.memory.save_run(result)
        return result

