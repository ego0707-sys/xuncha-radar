from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import time
from pathlib import Path

from .agent import KimiFormulaAgent
from .baseline import DirectKimiBaseline
from .engine import RadarEngine
from .memory import SQLiteMemoryStore
from .models import ResearchTask, to_jsonable
from .search import SearxNGSearchProvider
from .trace import TraceRecorder
from .verifier import HttpEvidenceVerifier


def _load_tasks(path: Path, selected: set[str]) -> list[dict]:
    with path.open("r", encoding="utf-8") as handle:
        tasks = json.load(handle)["tasks"]
    return [item for item in tasks if not selected or item["id"] in selected]


def run_benchmark(args: argparse.Namespace) -> int:
    if args.repeats < 3:
        raise SystemExit("正式盲测每题至少重复 3 次")
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    selected = set(args.task_id or [])
    tasks = _load_tasks(Path(args.tasks), selected)
    if not tasks:
        raise SystemExit("没有匹配的测试任务")

    search_provider = None
    if args.search_provider == "searxng":
        if not args.search_api_url:
            raise SystemExit("--search-provider searxng 时必须提供 --search-api-url")
        search_provider = SearxNGSearchProvider(args.search_api_url)
    client = KimiFormulaAgent(
        base_url=args.base_url,
        model=args.model,
        reasoning_effort=args.reasoning_effort,
        search_provider=search_provider,
    )
    baseline = DirectKimiBaseline(client)
    rng = random.Random(args.seed)
    blinded_cases = []
    answer_key = []
    manifest_cases = []

    for item in tasks:
        for repeat in range(1, args.repeats + 1):
            case_id = f"{item['id']}-R{repeat:02d}"
            task = ResearchTask(
                prompt=item["prompt"],
                mode="benchmark",
                now=args.now,
                window_hours=args.window_hours,
                max_searches=args.max_searches,
                max_rounds=args.max_rounds,
                max_results=10,
            )
            memory = SQLiteMemoryStore(output_dir / "memory" / f"{case_id}.sqlite3")
            radar = RadarEngine(
                client,
                HttpEvidenceVerifier(timeout_seconds=args.verify_timeout),
                memory,
            )
            radar_trace_path = output_dir / "traces" / f"{case_id}-radar.jsonl"
            baseline_trace = TraceRecorder()
            outputs: dict[str, object] = {}
            durations: dict[str, float] = {}
            traces: dict[str, str] = {}
            tokens: dict[str, int] = {}
            execution_order = ["R", "K"]
            rng.shuffle(execution_order)
            try:
                for arm in execution_order:
                    started = time.monotonic()
                    if arm == "R":
                        radar_result = radar.run(task, trace_path=radar_trace_path)
                        outputs["R"] = to_jsonable(radar_result)
                        tokens["R"] = radar_result.tool_health.total_tokens
                        traces["R"] = str(radar_trace_path)
                    else:
                        baseline_outcome = baseline.run(task, baseline_trace)
                        outputs["K"] = baseline_outcome.content
                        tokens["K"] = baseline_outcome.total_tokens
                        traces["K"] = baseline_trace.dump_jsonl(
                            output_dir / "traces" / f"{case_id}-kimi.jsonl"
                        )
                    durations[arm] = time.monotonic() - started
            finally:
                memory.close()

            arms = [
                {"arm": "R", "output": outputs["R"]},
                {"arm": "K", "output": outputs["K"]},
            ]
            rng.shuffle(arms)
            blinded_cases.append(
                {
                    "case_id": case_id,
                    "task_id": item["id"],
                    "repeat": repeat,
                    "task": item["prompt"],
                    "must_find": item.get("must_find", []),
                    "must_not": item.get("must_not", []),
                    "response_a": arms[0]["output"],
                    "response_b": arms[1]["output"],
                    "human_evaluation": {
                        "winner": None,
                        "response_a_useful_leads": None,
                        "response_b_useful_leads": None,
                        "response_a_direct_sample_precision": None,
                        "response_b_direct_sample_precision": None,
                        "response_a_link_consistency": None,
                        "response_b_link_consistency": None,
                        "notes": "",
                    },
                }
            )
            answer_key.append(
                {
                    "case_id": case_id,
                    "task_id": item["id"],
                    "response_a": arms[0]["arm"],
                    "response_b": arms[1]["arm"],
                }
            )
            manifest_cases.append(
                {
                    "case_id": case_id,
                    "task_id": item["id"],
                    "repeat": repeat,
                    "execution_order": execution_order,
                    "radar_seconds": round(durations["R"], 3),
                    "kimi_seconds": round(durations["K"], 3),
                    "radar_tokens": tokens["R"],
                    "kimi_tokens": tokens["K"],
                    "radar_trace": traces["R"],
                    "kimi_trace": traces["K"],
                }
            )

    files = {
        "blinded_cases.json": {"cases": blinded_cases},
        "answer_key.json": {"key": answer_key},
        "manifest.json": {
            "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "model": args.model,
            "reasoning_effort": args.reasoning_effort,
            "window_hours": args.window_hours,
            "max_searches": args.max_searches,
            "max_rounds": args.max_rounds,
            "repeats": args.repeats,
            "seed": args.seed,
            "cases": manifest_cases,
        },
    }
    for name, payload in files.items():
        (output_dir / name).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(
        json.dumps(
            {
                "output_dir": str(output_dir.resolve()),
                "task_count": len(tasks),
                "case_count": len(blinded_cases),
            },
            ensure_ascii=False,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="巡查雷达 vs 直接 Kimi 盲测")
    parser.add_argument("--tasks", default="evals/historical_tasks.json")
    parser.add_argument("--task-id", action="append")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model", default="kimi-k3")
    parser.add_argument("--base-url", default="https://api.moonshot.cn/v1")
    parser.add_argument("--reasoning-effort", choices=["low", "high", "max"], default="high")
    parser.add_argument("--search-provider", choices=["kimi-formula", "searxng"], default="kimi-formula")
    parser.add_argument("--search-api-url")
    parser.add_argument("--now", default=dt.datetime.now(dt.timezone.utc).isoformat())
    parser.add_argument("--window-hours", type=int, default=72)
    parser.add_argument("--max-searches", type=int, default=12)
    parser.add_argument("--max-rounds", type=int, default=8)
    parser.add_argument("--verify-timeout", type=float, default=12.0)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--seed", type=int, default=20260813)
    return parser


def main(argv: list[str] | None = None) -> int:
    return run_benchmark(build_parser().parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
