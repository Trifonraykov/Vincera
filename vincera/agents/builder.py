"""Builder Agent — designs, writes, reviews, and deploys automations."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from vincera.agents.base import BaseAgent

if TYPE_CHECKING:
    from vincera.builder.code_generator import CodeGenerator, GeneratedCode
    from vincera.builder.code_reviewer import CodeReviewer, ReviewResult
    from vincera.builder.test_generator import TestGenerator
    from vincera.config import VinceraSettings
    from vincera.core.llm import OpenRouterClient
    from vincera.core.state import GlobalState
    from vincera.execution.deployment_pipeline import DeploymentPipeline
    from vincera.execution.sandbox import DockerSandbox
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.verification.verifier import Verifier

logger = logging.getLogger(__name__)


class BuilderAgent(BaseAgent):
    """Generates automation code, reviews it, tests it, and deploys through the pipeline."""

    MAX_ITERATIONS = 3

    def __init__(
        self,
        name: str,
        company_id: str,
        config: VinceraSettings,
        llm: OpenRouterClient,
        supabase: SupabaseManager,
        state: GlobalState,
        verifier: Verifier,
        code_generator: CodeGenerator,
        code_reviewer: CodeReviewer,
        test_generator: TestGenerator,
        sandbox: DockerSandbox,
        pipeline: DeploymentPipeline,
    ) -> None:
        super().__init__(name, company_id, config, llm, supabase, state, verifier)
        self._generator = code_generator
        self._reviewer = code_reviewer
        self._test_gen = test_generator
        self._sandbox = sandbox
        self._pipeline = pipeline

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def run(self, task: dict) -> dict:
        name = task["name"]
        description = task["description"]
        business_context = task.get("business_context", "")
        constraints = task.get("constraints", [])

        # 1. Generate code
        await self.send_message(
            f"Starting to build automation: {name}\n{description}",
            message_type="chat",
        )

        code = await self._generator.generate(name, description, business_context, constraints)
        await self.send_message(
            f"Generated initial code for '{name}' ({len(code.script)} chars). Running code review...",
            message_type="chat",
        )

        # 2. Review code
        review = await self._reviewer.review(code, description)

        if not review.approved:
            await self.send_message(
                f"Code review found issues: {', '.join(review.issues[:3])}. Fixing...",
                message_type="chat",
            )
            code = await self._fix_code(code, review, description)
            review = await self._reviewer.review(code, description)

        # 3. Generate tests
        tests = await self._test_gen.generate_tests(code, description)
        await self.send_message(
            f"Generated {len(tests)} test cases. Running sandbox tests...",
            message_type="chat",
        )

        # 4. Sandbox execution
        sandbox_result = await self._sandbox.execute_python(
            code.script, timeout=code.estimated_runtime_seconds,
        )

        attempts = 0
        if not sandbox_result.success:
            while not sandbox_result.success and attempts < self.MAX_ITERATIONS:
                attempts += 1
                await self.send_message(
                    f"Sandbox test failed (attempt {attempts}/{self.MAX_ITERATIONS}). "
                    f"Error: {sandbox_result.stderr[:200]}. Fixing...",
                    message_type="chat",
                )
                code = await self._generator.iterate(code, sandbox_result.stderr)
                sandbox_result = await self._sandbox.execute_python(
                    code.script, timeout=code.estimated_runtime_seconds,
                )

            if not sandbox_result.success:
                await self.send_message(
                    f"Failed to build '{name}' after {self.MAX_ITERATIONS} attempts. "
                    f"Last error: {sandbox_result.stderr[:200]}",
                    message_type="chat",
                )
                await self.record_to_playbook(
                    "build_automation", name, "generate + sandbox",
                    f"Failed: {sandbox_result.stderr[:200]}", False,
                    f"Attempted {self.MAX_ITERATIONS} iterations",
                )
                return {
                    "status": "failed",
                    "reason": sandbox_result.stderr[:500],
                    "attempts": attempts,
                }

        # 5. Deployment pipeline
        deployment = await self._pipeline.start_deployment(name, code.script, description)
        pipeline_sandbox = await self._pipeline.run_sandbox_stage(deployment.deployment_id)

        shadow_result = None
        if pipeline_sandbox.success:
            shadow_result = await self._pipeline.run_shadow_stage(
                deployment.deployment_id, description,
            )
            await self.send_message(
                f"'{name}' passed sandbox and shadow testing.\n"
                f"Shadow confidence: {shadow_result.confidence_score:.0%}\n"
                f"Recommendation: {shadow_result.recommendation}\n"
                "Ready for canary deployment pending approval.",
                message_type="chat",
            )
        else:
            await self.send_message(
                f"'{name}' passed local sandbox but failed pipeline sandbox. Needs investigation.",
                message_type="chat",
            )

        # 6. Record to playbook
        await self.record_to_playbook(
            "build_automation", name, "generate + review + sandbox + pipeline",
            f"Shadow recommendation: {shadow_result.recommendation if shadow_result else 'N/A'}",
            pipeline_sandbox.success,
            f"Code: {len(code.script)} chars, {len(code.dependencies)} deps, "
            f"review quality: {review.quality_score}",
        )

        # 7. Save script locally
        scripts_dir = self._config.home_dir / "scripts"
        scripts_dir.mkdir(parents=True, exist_ok=True)
        script_path = scripts_dir / f"{name.replace(' ', '_').lower()}.py"
        script_path.write_text(code.script)

        return {
            "status": "success" if pipeline_sandbox.success else "partial",
            "deployment_id": deployment.deployment_id,
            "code_quality": review.quality_score,
            "shadow_confidence": shadow_result.confidence_score if shadow_result else 0.0,
            "recommendation": shadow_result.recommendation if shadow_result else "fix",
            "tests_generated": len(tests),
            "script_path": str(script_path),
        }

    # ------------------------------------------------------------------
    # Fix code based on review
    # ------------------------------------------------------------------

    async def _fix_code(
        self,
        code: GeneratedCode,
        review: ReviewResult,
        task_description: str,
    ) -> GeneratedCode:
        all_issues = review.issues + review.security_concerns
        error_msg = "; ".join(all_issues)
        return await self._generator.iterate(code, error_msg, feedback=f"Task: {task_description}")

    # ------------------------------------------------------------------
    # Handle user messages
    # ------------------------------------------------------------------

    async def handle_message(self, user_message: str) -> str:
        lower = user_message.lower()
        if any(w in lower for w in ("build", "create", "make", "automate")):
            msg = (
                "I can build that. Could you describe what you want automated? I'll need:\n"
                "1. What the automation should do\n"
                "2. What data it works with\n"
                "3. How often it should run"
            )
            await self.send_message(msg, message_type="chat")
            return msg
        return await super().handle_message(user_message)
