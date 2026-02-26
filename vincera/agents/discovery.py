"""Discovery Agent: narrated system discovery that builds a company model."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from vincera.agents.base import BaseAgent
from vincera.discovery.filesystem import DirectoryEntry, DirectoryTree

if TYPE_CHECKING:
    from vincera.config import VinceraSettings
    from vincera.core.llm import OpenRouterClient
    from vincera.core.state import GlobalState
    from vincera.discovery.company_model import CompanyModelBuilder
    from vincera.discovery.database import DatabaseDiscovery
    from vincera.discovery.filesystem import FilesystemMapper
    from vincera.discovery.network import NetworkDiscovery
    from vincera.discovery.scanner import SystemScanner
    from vincera.discovery.spreadsheet import SpreadsheetScanner
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.verification.verifier import Verifier

logger = logging.getLogger(__name__)


class DiscoveryAgent(BaseAgent):
    """Orchestrates full system discovery with real-time narration."""

    def __init__(
        self,
        name: str,
        company_id: str,
        config: "VinceraSettings",
        llm: "OpenRouterClient",
        supabase: "SupabaseManager",
        state: "GlobalState",
        verifier: "Verifier",
        scanner: "SystemScanner",
        filesystem: "FilesystemMapper",
        network: "NetworkDiscovery",
        database: "DatabaseDiscovery",
        spreadsheet: "SpreadsheetScanner",
        model_builder: "CompanyModelBuilder",
    ) -> None:
        super().__init__(name, company_id, config, llm, supabase, state, verifier)
        self._scanner = scanner
        self._filesystem = filesystem
        self._network = network
        self._database = database
        self._spreadsheet = spreadsheet
        self._model_builder = model_builder

    async def run(self, task: dict) -> dict:
        """Run discovery. task["mode"] can be "initial" or "periodic"."""
        mode = task.get("mode", "initial")

        if mode == "initial":
            return await self._run_initial()
        else:
            return await self._run_periodic()

    async def _run_initial(self) -> dict:
        """Full initial discovery with narration."""
        await self.send_message(
            "Starting discovery. I'm going to look around your system and figure out "
            "how your business operates. I'll tell you what I find as I go.",
            message_type="discovery_narration",
        )

        # Phase 1: Environment
        await self.send_message(
            "Scanning your system environment...",
            message_type="discovery_narration",
        )
        env = await self._scanner.scan_environment()
        docker_note = (
            "Docker is installed." if env.docker_available
            else "No Docker found — I can still work, just with a simpler sandbox."
        )
        await self.send_message(
            f"You're running {env.os_name} {env.os_version} with {env.cpu_cores} CPU cores "
            f"and {env.ram_total_gb:.1f}GB RAM. {docker_note}",
            message_type="discovery_narration",
        )

        # Phase 2: Software
        await self.send_message(
            "Checking what software you have installed...",
            message_type="discovery_narration",
        )
        software = await self._scanner.scan_installed_software()
        notable = [s for s in software.data if s.get("category") in ("database", "accounting", "web_server", "development")]
        if notable:
            notable_names = ", ".join(s["name"] for s in notable[:10])
            await self.send_message(
                f"Found {len(software.data)} applications. Notable: {notable_names}.",
                message_type="discovery_narration",
            )
        else:
            await self.send_message(
                f"Found {len(software.data)} applications installed.",
                message_type="discovery_narration",
            )

        # Phase 3: Running processes
        processes = await self._scanner.scan_running_processes()
        dbs = [p for p in processes.data if p.get("category") == "database"]
        if dbs:
            db_names = ", ".join(p["name"] for p in dbs)
            await self.send_message(
                f"I see {len(dbs)} database(s) running: {db_names}. I'll inspect their schemas next.",
                message_type="discovery_narration",
            )

        # Phase 4: File system
        await self.send_message(
            "Mapping your file system (names only — I never read file contents)...",
            message_type="discovery_narration",
        )
        fs_trees = await self._filesystem.map_standard_paths()
        fs_summary = self._filesystem.get_summary(fs_trees)
        projects = await self._filesystem.identify_project_structures(trees=fs_trees)

        project_types = ", ".join(p.project_type for p in projects[:5]) if projects else "none"
        ext_top = ", ".join(f".{ext}" for ext in list(fs_summary.get("files_by_extension", {}).keys())[:5])
        await self.send_message(
            f"Mapped {fs_summary['total_files']} files across {fs_summary['total_dirs']} directories. "
            f"Found {len(projects)} project(s): {project_types}. "
            f"Most common file types: {ext_top}.",
            message_type="discovery_narration",
        )

        # Phase 5: Database schemas
        db_schemas = []
        if dbs:
            for db_proc in dbs:
                db_info_list = await self._database.discover_databases([db_proc])
                for db_info in db_info_list:
                    schema = await self._database.extract_schema(db_info)
                    if schema:
                        db_schemas.append(schema)
                        largest = sorted(schema.tables, key=lambda t: t.row_count, reverse=True)[:3]
                        largest_desc = ", ".join(f"{t.name} ({t.row_count} rows)" for t in largest)
                        await self.send_message(
                            f"Connected to {db_info.name} ({db_info.db_type}). "
                            f"Found {len(schema.tables)} tables. Largest: {largest_desc}.",
                            message_type="discovery_narration",
                        )

        # Phase 6: Spreadsheets
        spreadsheet_paths = [
            entry.path
            for tree in fs_trees
            for entry in self._collect_files(tree)
            if entry.extension in (".xlsx", ".csv", ".xls", ".tsv")
        ]
        spreadsheets = []
        if spreadsheet_paths:
            from pathlib import Path as _Path
            spreadsheets = await self._spreadsheet.scan_headers([_Path(p) for p in spreadsheet_paths])
            if spreadsheets:
                patterns = await self._spreadsheet.analyze_patterns(spreadsheets)
                await self.send_message(
                    f"Found {len(spreadsheet_paths)} spreadsheet files. "
                    f"Scanned headers on {len(spreadsheets)}. "
                    f"Patterns detected: {patterns.get('summary', 'analyzing...')}",
                    message_type="discovery_narration",
                )

        # Phase 7: Network shares
        shares = await self._network.discover_shares()
        if shares:
            share_names = ", ".join(s.get("name", "unknown") for s in shares[:5])
            await self.send_message(
                f"Found {len(shares)} network share(s): {share_names}.",
                message_type="discovery_narration",
            )

        # Phase 8: Scheduled tasks
        tasks = await self._scanner.scan_scheduled_tasks()
        if tasks.data:
            await self.send_message(
                f"Found {len(tasks.data)} scheduled task(s) already running on this machine.",
                message_type="discovery_narration",
            )

        # Phase 9: Build company model
        await self.send_message(
            "I have enough data now. Building my model of your business...",
            message_type="discovery_narration",
        )
        model = await self._model_builder.build(
            env, software, processes, tasks, fs_trees, db_schemas, spreadsheets,
        )
        narration = await self._model_builder.to_narration(model)
        await self.send_message(narration, message_type="discovery_narration")

        # Save
        knowledge_dir = self._config.home_dir / "knowledge"
        knowledge_dir.mkdir(parents=True, exist_ok=True)
        model.save_local(knowledge_dir / "company_model.json")
        model.save_to_supabase(self._sb, self._company_id)

        # Record to playbook
        await self.record_to_playbook(
            action_type="initial_discovery",
            context="First scan of company environment",
            approach="Full system scan + company model generation",
            outcome=f"Found {model.business_type} business",
            success=True,
            lessons=f"Identified {len(model.automation_opportunities)} automation opportunities",
        )

        return {
            "status": "complete",
            "business_type": model.business_type,
            "opportunities": len(model.automation_opportunities),
        }

    async def _run_periodic(self) -> dict:
        """Lighter re-scan. Only narrate significant changes."""
        await self.send_message(
            "Running periodic check for changes...",
            message_type="discovery_narration",
        )
        # Stub — will be fleshed out when we have comparison logic
        return {"status": "complete", "mode": "periodic", "changes_detected": 0}

    def _collect_files(self, tree: DirectoryTree) -> list[DirectoryEntry]:
        """Recursively flatten a DirectoryTree into file entries."""
        files: list[DirectoryEntry] = []
        self._flatten_entries(tree.entries, files)
        return files

    def _flatten_entries(self, entries: list[DirectoryEntry], out: list[DirectoryEntry]) -> None:
        """Recursive helper for _collect_files."""
        for entry in entries:
            if not entry.is_dir:
                out.append(entry)
            if entry.children:
                self._flatten_entries(entry.children, out)
