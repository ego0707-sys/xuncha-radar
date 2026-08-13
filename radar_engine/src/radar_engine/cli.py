from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .agent import FixtureAgent, KimiFormulaAgent
from .diagnostics import summarize_legacy_export
from .engine import RadarEngine
from .memory import SQLiteMemoryStore
from .models import (
    AccessState,
    EvidenceVerification,
    ResearchTask,
    RunState,
    dumps,
)
from .search import SearxNGSearchProvider
from .verifier import FixtureVerifier, HttpEvidenceVerifier


def _fixture_verifier(data: dict) -> FixtureVerifier:
    results = {}
    for url, raw in (data.get("verifications") or {}).items():
        results[url] = EvidenceVerification(
            url=url,
            access=AccessState(raw.get("access", "failed")),
            final_url=raw.get("final_url"),
            http_status=raw.get("http_status"),
            title_match=bool(raw.get("title_match", False)),
            date_match=bool(raw.get("date_match", False)),
            content_match=bool(raw.get("content_match", False)),
            observed_title=raw.get("observed_title"),
            observed_date=raw.get("observed_date"),
            reason=raw.get("reason"),
        )
    return FixtureVerifier(results)


def run_command(args: argparse.Namespace) -> int:
    memory = SQLiteMemoryStore(args.memory)
    try:
        if args.backend == "fixture":
            if not args.fixture:
                raise SystemExit("--backend fixture 时必须提供 --fixture")
            fixture_path = Path(args.fixture)
            with fixture_path.open("r", encoding="utf-8") as handle:
                fixture_data = json.load(handle)
            agent = FixtureAgent(fixture_data)
            verifier = _fixture_verifier(fixture_data)
        else:
            search_provider = None
            if args.search_provider == "searxng":
                if not args.search_api_url:
                    raise SystemExit("--search-provider searxng 时必须提供 --search-api-url")
                search_provider = SearxNGSearchProvider(args.search_api_url)
            agent = KimiFormulaAgent(
                base_url=args.base_url,
                model=args.model,
                reasoning_effort=args.reasoning_effort,
                search_provider=search_provider,
            )
            verifier = HttpEvidenceVerifier(timeout_seconds=args.verify_timeout)

        task = ResearchTask(
            prompt=args.task,
            mode=args.mode,
            now=args.now,
            window_hours=args.window_hours,
            max_searches=args.max_searches,
            max_rounds=args.max_rounds,
            max_results=args.max_results,
        )
        engine = RadarEngine(agent=agent, verifier=verifier, memory=memory)
        result = engine.run(task, trace_path=args.trace)
        rendered = dumps(result)
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(rendered + "\n", encoding="utf-8")
        print(rendered)
        return 2 if result.state is RunState.FAILED else 0
    finally:
        memory.close()


def diagnostics_command(args: argparse.Namespace) -> int:
    reports = []
    for value in args.inputs:
        path = Path(value)
        with path.open("r", encoding="utf-8") as handle:
            reports.append({"source": path.name, **summarize_legacy_export(json.load(handle))})
    rendered = json.dumps({"reports": reports}, ensure_ascii=False, indent=2)
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


def feedback_command(args: argparse.Namespace) -> int:
    memory = SQLiteMemoryStore(args.memory)
    try:
        memory.record_feedback(args.fingerprint, args.label, args.note)
    finally:
        memory.close()
    print("反馈已记录")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="xuncha-radar",
        description="巡查雷达无界面研究 Agent 引擎",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="执行一次研究任务")
    run_parser.add_argument("--task", required=True)
    run_parser.add_argument("--backend", choices=["kimi", "fixture"], default="kimi")
    run_parser.add_argument("--fixture")
    run_parser.add_argument("--mode", default="topic")
    run_parser.add_argument("--now", default=ResearchTask(prompt="placeholder").now)
    run_parser.add_argument("--window-hours", type=int, default=72)
    run_parser.add_argument("--max-searches", type=int, default=12)
    run_parser.add_argument("--max-rounds", type=int, default=8)
    run_parser.add_argument("--max-results", type=int, default=10)
    run_parser.add_argument("--model", default="kimi-k3")
    run_parser.add_argument("--base-url", default="https://api.moonshot.cn/v1")
    run_parser.add_argument("--reasoning-effort", choices=["low", "high", "max"], default="high")
    run_parser.add_argument("--search-provider", choices=["kimi-formula", "searxng"], default="kimi-formula")
    run_parser.add_argument("--search-api-url")
    run_parser.add_argument("--verify-timeout", type=float, default=12.0)
    run_parser.add_argument("--memory", default="artifacts/radar_memory.sqlite3")
    run_parser.add_argument("--trace", default="artifacts/latest-trace.jsonl")
    run_parser.add_argument("--output")
    run_parser.set_defaults(func=run_command)

    diagnostic_parser = subparsers.add_parser("diagnostics", help="检查旧版诊断导出")
    diagnostic_parser.add_argument("inputs", nargs="+")
    diagnostic_parser.add_argument("--output")
    diagnostic_parser.set_defaults(func=diagnostics_command)

    feedback_parser = subparsers.add_parser("feedback", help="写入团队反馈")
    feedback_parser.add_argument("fingerprint")
    feedback_parser.add_argument(
        "label",
        choices=["valuable", "continue", "false_positive", "used_in_report"],
    )
    feedback_parser.add_argument("--note")
    feedback_parser.add_argument("--memory", default="artifacts/radar_memory.sqlite3")
    feedback_parser.set_defaults(func=feedback_command)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
