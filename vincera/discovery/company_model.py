"""Company model builder: assembles discovery data into a structured business model."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from vincera.core.llm import OpenRouterClient
    from vincera.knowledge.supabase_client import SupabaseManager

logger = logging.getLogger(__name__)


class CompanyModel(BaseModel):
    """Structured model of a company's operations, built from discovery data."""

    business_type: str = "unknown"
    industry: str = "unknown"
    confidence: float = 0.0
    software_stack: list[dict] = []
    data_architecture: list[dict] = []
    detected_processes: list[dict] = []
    automation_opportunities: list[dict] = []
    pain_points: list[str] = []
    risk_areas: list[str] = []
    key_findings: list[str] = []

    def save_local(self, path: Path) -> None:
        """Save the model to a local JSON file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.model_dump_json(indent=2), encoding="utf-8")

    def save_to_supabase(self, supabase: "SupabaseManager", company_id: str) -> None:
        """Save the model to Supabase knowledge table."""
        supabase.add_knowledge(
            company_id=company_id,
            category="company_model",
            key="company_model",
            value=self.model_dump_json(),
            source="discovery_agent",
            confidence=self.confidence,
        )


_BUILD_SCHEMA = {
    "type": "object",
    "properties": {
        "business_type": {"type": "string"},
        "industry": {"type": "string"},
        "confidence": {"type": "number"},
        "software_stack": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "category": {"type": "string"},
                    "role": {"type": "string"},
                },
            },
        },
        "data_architecture": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "source": {"type": "string"},
                    "type": {"type": "string"},
                    "description": {"type": "string"},
                },
            },
        },
        "detected_processes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "manual": {"type": "boolean"},
                    "frequency": {"type": "string"},
                    "evidence": {"type": "string"},
                },
            },
        },
        "automation_opportunities": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "estimated_hours_saved": {"type": "number"},
                    "complexity": {"type": "string"},
                    "evidence": {"type": "string"},
                },
            },
        },
        "pain_points": {"type": "array", "items": {"type": "string"}},
        "risk_areas": {"type": "array", "items": {"type": "string"}},
        "key_findings": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "business_type", "industry", "confidence", "software_stack",
        "data_architecture", "detected_processes", "automation_opportunities",
        "pain_points", "risk_areas", "key_findings",
    ],
}


class CompanyModelBuilder:
    """Builds a CompanyModel from all discovery data using Claude."""

    def __init__(self, llm: "OpenRouterClient") -> None:
        self._llm = llm

    async def build(
        self,
        env,
        software,
        processes,
        tasks,
        filesystem,
        databases,
        spreadsheets,
    ) -> CompanyModel:
        """Assemble discovery data and send to Claude for structured analysis."""
        summary = self._assemble_summary(env, software, processes, tasks, filesystem, databases, spreadsheets)

        try:
            result = await self._llm.think_structured(
                system_prompt=(
                    "You are analyzing a company's technical environment. Based on the discovery "
                    "data below, build a complete model of how this business operates. You MUST "
                    "only state what the evidence directly supports. Do not infer anything without "
                    "citing specific evidence from the scan data."
                ),
                user_message=summary,
                response_schema=_BUILD_SCHEMA,
            )
            return CompanyModel(**result)
        except Exception as exc:
            logger.error("Failed to build company model: %s", exc)
            return CompanyModel()

    async def to_narration(self, model: CompanyModel) -> str:
        """Generate a human-readable narration of the company model."""
        try:
            return await self._llm.think(
                system_prompt=(
                    "You are giving a briefing about a company's technical environment to the "
                    "company owner through a chat dashboard. Be conversational, specific, and "
                    "insightful — like a smart colleague giving a summary. Reference specific "
                    "findings. Keep it concise but informative."
                ),
                user_message=f"Company model data:\n{model.model_dump_json(indent=2)}",
            )
        except Exception as exc:
            logger.error("Failed to generate narration: %s", exc)
            return f"Discovery complete. Business type: {model.business_type}, Industry: {model.industry}."

    def _assemble_summary(self, env, software, processes, tasks, filesystem, databases, spreadsheets) -> str:
        """Assemble all discovery data into a summary string for the LLM."""
        parts: list[str] = []

        # Environment
        try:
            parts.append(f"OS: {env.os_name} {env.os_version}, CPU cores: {env.cpu_cores}, RAM: {env.ram_total_gb}GB")
            parts.append(f"Docker: {'available' if env.docker_available else 'not available'}")
        except AttributeError:
            pass

        # Software
        try:
            sw_data = software.data if hasattr(software, "data") else software
            if sw_data:
                sw_summary = ", ".join(
                    f"{s.get('name', 'unknown')} ({s.get('category', 'other')})"
                    for s in (sw_data[:20] if isinstance(sw_data, list) else [])
                )
                parts.append(f"Software: {sw_summary}")
        except (AttributeError, TypeError):
            pass

        # Processes
        try:
            proc_data = processes.data if hasattr(processes, "data") else processes
            if proc_data:
                notable = [p for p in (proc_data if isinstance(proc_data, list) else []) if p.get("category")]
                if notable:
                    parts.append(f"Notable processes: {', '.join(p.get('name', '') for p in notable[:10])}")
        except (AttributeError, TypeError):
            pass

        # Databases
        if databases:
            db_summary = ", ".join(
                f"{d.database_name} ({d.db_type}, {len(d.tables)} tables)"
                if hasattr(d, "tables") else str(d)
                for d in databases[:5]
            )
            parts.append(f"Databases: {db_summary}")

        # Spreadsheets
        if spreadsheets:
            ss_summary = ", ".join(
                f"{s.file_name}: [{', '.join(s.headers[:5])}]"
                if hasattr(s, "headers") else str(s)
                for s in spreadsheets[:10]
            )
            parts.append(f"Spreadsheets: {ss_summary}")

        # Filesystem
        if filesystem:
            if isinstance(filesystem, list):
                total_trees = len(filesystem)
                parts.append(f"Filesystem: {total_trees} directory trees mapped")

        return "\n".join(parts) if parts else "Minimal discovery data available."
