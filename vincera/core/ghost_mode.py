"""Ghost Mode controller: observe-only period with daily reports."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from vincera.config import VinceraSettings
    from vincera.knowledge.supabase_client import SupabaseManager

logger = logging.getLogger(__name__)


class GhostModeController:
    """Controls ghost mode: the agent watches but never acts."""

    def __init__(
        self,
        supabase: "SupabaseManager",
        config: "VinceraSettings",
    ) -> None:
        self._sb = supabase
        self._config = config
        self._ghost_mode_until: datetime | None = None
        self._start_date: datetime | None = None
        self._company_id: str | None = None
        self._observations: list[dict] = []
        self._would_have: list[dict] = []

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def is_active(self) -> bool:
        if self._ghost_mode_until is None:
            return False
        return datetime.now(timezone.utc) < self._ghost_mode_until

    @property
    def days_remaining(self) -> int:
        if self._ghost_mode_until is None:
            return 0
        delta = self._ghost_mode_until - datetime.now(timezone.utc)
        return max(0, delta.days)

    @property
    def start_date(self) -> datetime | None:
        return self._start_date

    @property
    def end_date(self) -> datetime | None:
        return self._ghost_mode_until

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self, company_id: str, days: int) -> None:
        """Start ghost mode for the given number of days."""
        now = datetime.now(timezone.utc)
        self._start_date = now
        self._ghost_mode_until = now + timedelta(days=days)
        self._company_id = company_id
        self._observations = []
        self._would_have = []

        self._sb.update_company(company_id, {
            "status": "ghost",
            "ghost_mode_until": self._ghost_mode_until.isoformat(),
        })

        self._sb.send_message(
            company_id,
            "ghost_mode",
            f"I'm now in Ghost Mode for {days} days. I'll watch how your business "
            f"runs and tell you what I would automate \u2014 without touching anything. "
            f"Think of it as a free trial of my brain.",
            "chat",
        )

    async def observe_process(
        self,
        company_id: str,
        description: str,
        data_involved: str,
        estimated_time_minutes: float,
        frequency: str,
    ) -> None:
        """Record an observed manual process."""
        self._observations.append({
            "description": description,
            "data_involved": data_involved,
            "estimated_time_minutes": estimated_time_minutes,
            "frequency": frequency,
            "observed_at": datetime.now(timezone.utc).isoformat(),
        })

    async def would_have_automated(
        self,
        company_id: str,
        automation_name: str,
        description: str,
        estimated_hours_saved: float,
        complexity: str,
    ) -> None:
        """Record an automation the agent would have deployed."""
        self._would_have.append({
            "automation_name": automation_name,
            "description": description,
            "estimated_hours_saved": estimated_hours_saved,
            "complexity": complexity,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
        })

    async def generate_daily_report(self, company_id: str) -> dict:
        """Compile today's observations into a report."""
        day_num = self._get_day_number(company_id)
        total_hours = sum(w.get("estimated_hours_saved", 0) for w in self._would_have)

        report = {
            "report_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "day_number": day_num,
            "observed_processes": list(self._observations),
            "would_have_automated": list(self._would_have),
            "estimated_hours_saved": total_hours,
            "estimated_tasks_automated": len(self._would_have),
            "key_observations": sorted(
                self._observations,
                key=lambda o: o.get("estimated_time_minutes", 0),
                reverse=True,
            )[:5],
        }

        self._sb.save_ghost_report(company_id, report)

        # Build narration
        narration_parts = [f"Day {day_num} of Ghost Mode."]

        if self._observations:
            narration_parts.append("Today I observed:")
            for obs in self._observations[:5]:
                narration_parts.append(
                    f"- Someone manually {obs['description']} "
                    f"(est. {obs['estimated_time_minutes']:.0f} min)"
                )

        if self._would_have:
            narration_parts.append("\nIf I had been active, I would have:")
            for wh in self._would_have[:5]:
                narration_parts.append(
                    f"- Deployed {wh['automation_name']} "
                    f"(saving est. {wh['estimated_hours_saved']:.1f} hrs/week)"
                )

        if total_hours > 0:
            narration_parts.append(
                f"\nRunning total: I estimate I would have saved {total_hours:.1f} hours so far."
            )

        self._sb.send_message(
            company_id, "ghost_mode", "\n".join(narration_parts), "chat",
        )

        # Clear for next day
        self._observations.clear()
        self._would_have.clear()

        return report

    async def should_end(self, company_id: str) -> bool:
        """Check if ghost mode should end."""
        return not self.is_active

    async def end(self, company_id: str) -> None:
        """End ghost mode and send final summary."""
        reports = self._sb.get_ghost_reports(company_id)

        total_hours = sum(r.get("estimated_hours_saved", 0) for r in reports)
        total_tasks = sum(r.get("estimated_tasks_automated", 0) for r in reports)
        total_days = len(reports)

        # Collect all automations across reports
        all_automations: list[dict] = []
        for r in reports:
            all_automations.extend(r.get("would_have_automated", []))

        # Sort by hours saved descending
        all_automations.sort(
            key=lambda a: a.get("estimated_hours_saved", 0), reverse=True,
        )

        # Build summary
        parts = [
            f"Ghost Mode is over. In {total_days} days of watching, I would have saved "
            f"an estimated {total_hours:.1f} hours and automated {total_tasks} tasks.",
        ]

        if all_automations:
            parts.append("\nTop automations I'm ready to deploy:")
            for i, auto in enumerate(all_automations[:3], 1):
                parts.append(
                    f"{i}. {auto.get('automation_name', 'Unknown')} "
                    f"\u2014 est. {auto.get('estimated_hours_saved', 0):.1f} hrs/week saved"
                )

        parts.append(
            "\nI'm now switching to Active Mode. I'll start with the highest-impact "
            "automations and ask for your approval before deploying each one."
        )

        self._sb.send_message(
            company_id, "ghost_mode", "\n".join(parts), "chat",
        )

        self._sb.update_company(company_id, {
            "status": "active",
            "ghost_mode_until": None,
        })

        # Reset local state
        self._ghost_mode_until = None
        self._start_date = None
        self._company_id = None

    def _get_day_number(self, company_id: str) -> int:
        """Calculate which day of ghost mode we're on (1-indexed)."""
        if self._start_date is None:
            return 1
        delta = datetime.now(timezone.utc) - self._start_date
        return max(1, delta.days + 1)
