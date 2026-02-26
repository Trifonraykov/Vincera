"""Agent factory — single point of construction for all Vincera components."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from vincera.config import VinceraSettings
    from vincera.core.llm import OpenRouterClient
    from vincera.core.state import GlobalState
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.utils.db import VinceraDB

logger = logging.getLogger(__name__)


class AgentFactory:
    """Creates all agents and supporting components with proper dependency injection."""

    @staticmethod
    def create_all(
        config: "VinceraSettings",
        llm: "OpenRouterClient",
        supabase: "SupabaseManager",
        state: "GlobalState",
        db: "VinceraDB",
    ) -> dict:
        """Create all components and return them in a dict.

        Returns dict with keys:
            agents, orchestrator, scheduler, sandbox, pipeline,
            monitor, rollback, ghost, authority, corrections,
            training_engine, verifier, ontology, priority.
        """
        # Lazy imports to keep module-level lightweight
        from vincera.agents.analyst import AnalystAgent
        from vincera.agents.builder import BuilderAgent
        from vincera.agents.discovery import DiscoveryAgent
        from vincera.agents.operator import OperatorAgent
        from vincera.agents.research import ResearchAgent
        from vincera.agents.trainer import TrainerAgent
        from vincera.agents.unstuck import UnstuckAgent
        from vincera.builder.code_generator import CodeGenerator
        from vincera.builder.code_reviewer import CodeReviewer
        from vincera.builder.test_generator import TestGenerator
        from vincera.core.authority import AuthorityManager
        from vincera.core.ghost_mode import GhostModeController
        from vincera.core.ontology import BusinessOntology
        from vincera.core.orchestrator import Orchestrator
        from vincera.core.priority import PriorityEngine
        from vincera.core.scheduler import Scheduler
        from vincera.discovery.company_model import CompanyModelBuilder
        from vincera.discovery.database import DatabaseDiscovery
        from vincera.discovery.filesystem import FilesystemMapper
        from vincera.discovery.network import NetworkDiscovery
        from vincera.discovery.scanner import SystemScanner
        from vincera.discovery.spreadsheet import SpreadsheetScanner
        from vincera.execution.canary import CanaryExecutor
        from vincera.execution.deployment_pipeline import DeploymentPipeline
        from vincera.execution.monitor import DeploymentMonitor
        from vincera.execution.rollback import RollbackManager
        from vincera.execution.sandbox import DockerSandbox
        from vincera.execution.shadow import ShadowExecutor
        from vincera.knowledge.playbook import PlaybookManager
        from vincera.platform import get_platform_service
        from vincera.research.knowledge_extractor import KnowledgeExtractor
        from vincera.research.researcher import BusinessResearcher
        from vincera.research.source_validator import SourceValidator
        from vincera.training.corrections import CorrectionTracker
        from vincera.training.trainer import TrainingEngine
        from vincera.verification.verifier import Verifier

        company_id = config.company_id or ""

        # ------------------------------------------------------------------
        # Core components (no agent deps)
        # ------------------------------------------------------------------
        verifier = Verifier(llm=llm)
        ontology = BusinessOntology()
        priority = PriorityEngine()
        playbook = PlaybookManager(supabase, llm)
        authority = AuthorityManager(supabase=supabase, company_id=company_id)
        ghost = GhostModeController(supabase=supabase, config=config)

        # ------------------------------------------------------------------
        # Execution components
        # ------------------------------------------------------------------
        sandbox = DockerSandbox(config=config)
        shadow = ShadowExecutor(sandbox=sandbox, llm=llm, verifier=verifier)
        pipeline = DeploymentPipeline(
            sandbox=sandbox, shadow=shadow, supabase=supabase,
            authority=authority, company_id=company_id,
        )
        canary = CanaryExecutor(sandbox=sandbox, supabase=supabase, company_id=company_id)
        monitor = DeploymentMonitor(supabase=supabase, company_id=company_id)
        rollback = RollbackManager(
            pipeline=pipeline, monitor=monitor,
            supabase=supabase, company_id=company_id,
        )

        # ------------------------------------------------------------------
        # Builder sub-components
        # ------------------------------------------------------------------
        code_gen = CodeGenerator(llm=llm)
        code_rev = CodeReviewer(llm=llm, sandbox=sandbox)
        test_gen = TestGenerator(llm=llm)

        # ------------------------------------------------------------------
        # Training components
        # ------------------------------------------------------------------
        corrections = CorrectionTracker(supabase=supabase, llm=llm, company_id=company_id)
        training_engine = TrainingEngine(
            llm=llm, supabase=supabase, playbook=playbook, company_id=company_id,
        )

        # ------------------------------------------------------------------
        # Discovery sub-components
        # ------------------------------------------------------------------
        platform_service = get_platform_service()
        scanner = SystemScanner(platform_service=platform_service)
        filesystem = FilesystemMapper()
        network = NetworkDiscovery(
            platform_service=platform_service, filesystem_mapper=filesystem,
        )
        database_discovery = DatabaseDiscovery()
        spreadsheet = SpreadsheetScanner(llm=llm)
        model_builder = CompanyModelBuilder(llm=llm)

        # ------------------------------------------------------------------
        # Research sub-components
        # ------------------------------------------------------------------
        researcher = BusinessResearcher(llm=llm)
        source_validator = SourceValidator()
        knowledge_extractor = KnowledgeExtractor(llm=llm)

        # ------------------------------------------------------------------
        # Shared base kwargs for all agents
        # ------------------------------------------------------------------
        base = dict(
            company_id=company_id,
            config=config,
            llm=llm,
            supabase=supabase,
            state=state,
            verifier=verifier,
        )

        # ------------------------------------------------------------------
        # Create agents
        # ------------------------------------------------------------------
        agents = {
            "discovery": DiscoveryAgent(
                name="discovery", **base,
                scanner=scanner, filesystem=filesystem,
                network=network, database=database_discovery,
                spreadsheet=spreadsheet, model_builder=model_builder,
            ),
            "research": ResearchAgent(
                name="research", **base,
                researcher=researcher, validator=source_validator,
                extractor=knowledge_extractor,
            ),
            "builder": BuilderAgent(
                name="builder", **base,
                code_generator=code_gen, code_reviewer=code_rev,
                test_generator=test_gen, sandbox=sandbox, pipeline=pipeline,
            ),
            "operator": OperatorAgent(
                name="operator", **base,
                sandbox=sandbox, monitor=monitor,
                canary=canary, pipeline=pipeline,
            ),
            "analyst": AnalystAgent(
                name="analyst", **base,
                monitor=monitor, priority_engine=priority,
            ),
            "unstuck": UnstuckAgent(
                name="unstuck", **base,
                sandbox=sandbox,
            ),
            "trainer": TrainerAgent(
                name="trainer", **base,
                correction_tracker=corrections, training_engine=training_engine,
            ),
        }

        # ------------------------------------------------------------------
        # Orchestrator (needs agents + all core components)
        # ------------------------------------------------------------------
        orchestrator = Orchestrator(
            config=config, llm=llm, supabase=supabase, state=state,
            ontology=ontology, priority_engine=priority, authority=authority,
            ghost_controller=ghost, verifier=verifier, agents=agents,
        )

        # ------------------------------------------------------------------
        # Scheduler (needs orchestrator)
        # ------------------------------------------------------------------
        scheduler = Scheduler(orchestrator=orchestrator, config=config, state=state)
        scheduler.setup_default_schedule()

        logger.info("AgentFactory: all components created for company %s", company_id)

        return {
            "agents": agents,
            "orchestrator": orchestrator,
            "scheduler": scheduler,
            "sandbox": sandbox,
            "pipeline": pipeline,
            "monitor": monitor,
            "rollback": rollback,
            "ghost": ghost,
            "authority": authority,
            "corrections": corrections,
            "training_engine": training_engine,
            "verifier": verifier,
            "ontology": ontology,
            "priority": priority,
        }
