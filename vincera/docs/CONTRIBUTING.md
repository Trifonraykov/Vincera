# Contributing to Vincera

## Development Setup

### Agent (Python)

```bash
cd Vincera
python -m venv .venv
source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -e ".[dev]"

# Run tests
pytest -v
```

### Dashboard (Next.js)

```bash
cd dashboard
npm install
cp .env.local.example .env.local
# Edit .env.local with your Supabase URL and anon key
npm run dev
```

### Local Supabase (optional)

For fully local development, use the Supabase CLI:

```bash
npx supabase start
# Use the local URL and keys printed by the CLI
```

## Adding a New Agent

### 1. Create the Agent File

Create `vincera/agents/my_agent.py`:

```python
"""My Agent — description of what it does."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from vincera.agents.base import BaseAgent

if TYPE_CHECKING:
    from vincera.config import VinceraSettings
    from vincera.core.llm import OpenRouterClient
    from vincera.core.state import GlobalState
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.verification.verifier import Verifier

logger = logging.getLogger(__name__)


class MyAgent(BaseAgent):
    """Description of the agent's purpose."""

    def __init__(
        self,
        name: str,
        company_id: str,
        config: "VinceraSettings",
        llm: "OpenRouterClient",
        supabase: "SupabaseManager",
        state: "GlobalState",
        verifier: "Verifier",
    ) -> None:
        super().__init__(name, company_id, config, llm, supabase, state, verifier)

    async def run(self, task: dict) -> dict:
        """Main execution logic. Called by execute() in BaseAgent."""
        # Use self._llm.think() for LLM calls
        # Use self._sb for Supabase operations
        # Use self.request_verification() before risky actions
        # Use self.request_approval() for user decisions

        result = await self._llm.think(
            "You are my_agent.",
            f"Process this task: {task}",
        )
        return {"result": result}
```

Key methods available from `BaseAgent`:
- `self._llm.think(system, user)` — LLM completion
- `self._sb.send_message(company_id, sender, content, type)` — send chat message
- `self._sb.log_event(...)` — log an event
- `self.request_verification(action)` — run 6-check verification
- `self.request_approval(question, option_a, option_b, context)` — ask user
- `self.consult_playbook(query)` — check playbook for past experience
- `self.record_to_playbook(...)` — record outcome for future reference
- `self.log_action(action_type, target, result)` — log to action history

### 2. Register with the Orchestrator

In `vincera/main.py`, where agents are instantiated and passed to the Orchestrator:

```python
from vincera.agents.my_agent import MyAgent

my_agent = MyAgent(
    name="my_agent",
    company_id=settings.company_id,
    config=settings,
    llm=llm_client,
    supabase=sb,
    state=state,
    verifier=verifier,
)

agents["my_agent"] = my_agent
```

The Orchestrator dispatches agents by name from its `_agents` dict.

### 3. Add Tests

Create `tests/test_my_agent.py`:

```python
"""Tests for MyAgent."""

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest


def _run(coro):
    return asyncio.run(coro)


class TestMyAgent:
    def _make_agent(self, tmp_path: Path):
        from vincera.agents.my_agent import MyAgent

        config = MagicMock()
        config.home_dir = tmp_path / "VinceraHQ"
        config.home_dir.mkdir(parents=True, exist_ok=True)
        (config.home_dir / "agents").mkdir(parents=True, exist_ok=True)
        config.company_name = "TestCorp"

        llm = MagicMock()
        llm.think = AsyncMock(return_value="done")

        sb = MagicMock()
        sb.send_message.return_value = {"id": "msg-1"}
        sb.log_event.return_value = {"id": "ev-1"}
        sb.query_knowledge.return_value = []

        state = MagicMock()
        state.update_agent_status = MagicMock()
        state.get_agent_status.return_value = {"status": "idle"}
        state._db = MagicMock()
        state._db.query.return_value = []

        verifier = MagicMock()

        return MyAgent(
            name="my_agent",
            company_id="comp-1",
            config=config,
            llm=llm,
            supabase=sb,
            state=state,
            verifier=verifier,
        )

    def test_run_returns_result(self, tmp_path: Path):
        agent = self._make_agent(tmp_path)
        result = _run(agent.execute({"type": "test"}))
        assert "result" in result

    def test_sets_completed_status(self, tmp_path: Path):
        from vincera.agents.base import AgentStatus

        agent = self._make_agent(tmp_path)
        _run(agent.execute({"type": "test"}))
        assert agent.status == AgentStatus.COMPLETED
```

Follow the mock patterns in `tests/conftest.py` for shared fixtures.

## Adding a New Dashboard Page

### 1. Create the Route

Create `dashboard/src/app/dashboard/my-page/page.tsx`:

```tsx
"use client";

import { motion } from "framer-motion";
import { pageTransition, staggerChildren } from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";

export default function MyPage() {
  const { companyId } = useDashboard();

  return (
    <motion.div
      variants={pageTransition}
      initial="initial"
      animate="animate"
      exit="exit"
      className="space-y-6"
    >
      <h1 className="text-2xl font-serif text-white">My Page</h1>

      <motion.div variants={staggerChildren} initial="initial" animate="animate">
        {/* Page content */}
      </motion.div>
    </motion.div>
  );
}
```

### 2. Follow the Design System

- Background: `bg-black`
- Text: `text-white`, accent: `text-[#00FF88]`
- Headings: `font-serif`
- Data/code: `font-mono`
- UI labels: default sans-serif
- Cards: `bg-zinc-900 border border-zinc-800 rounded-lg`
- Use `pageTransition` variant from `lib/animations.ts` on the root element
- Use `staggerChildren` for lists and grids

### 3. Add to Navigation

In `dashboard/src/components/ui/Sidebar.tsx`, add a nav item:

```tsx
{ label: "My Page", href: "/dashboard/my-page", icon: IconName }
```

Icons come from `lucide-react`. Choose one that matches the page's purpose.

### 4. Create a Hook (if needed)

If your page needs data from Supabase, create `dashboard/src/hooks/useMyData.ts`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { createBrowserClient } from "@/lib/supabase";

export function useMyData(companyId: string | null) {
  const [data, setData] = useState<MyType[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!companyId) return;
    const supabase = createBrowserClient();

    async function fetch() {
      const { data } = await supabase
        .from("my_table")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false });
      setData(data ?? []);
      setIsLoading(false);
    }

    fetch();

    // Optional: Realtime subscription
    const channel = supabase
      .channel("my_table_changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "my_table" }, () => {
        fetch();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [companyId]);

  return { data, isLoading };
}
```

## Adding a Supabase Table

### 1. Create Migration

Create a new file in `supabase/migrations/` with the next number:

```sql
-- 018_my_table.sql
-- Description of what this table stores.

CREATE TABLE IF NOT EXISTS my_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE my_table ENABLE ROW LEVEL SECURITY;

CREATE POLICY "my_table_select" ON my_table
  FOR SELECT USING (company_id = auth.uid()::uuid);

CREATE POLICY "my_table_insert" ON my_table
  FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);

CREATE POLICY "my_table_update" ON my_table
  FOR UPDATE USING (company_id = auth.uid()::uuid)
  WITH CHECK (company_id = auth.uid()::uuid);

-- Index
CREATE INDEX idx_my_table_company ON my_table(company_id);
```

Always include: RLS policies, company_id foreign key, appropriate indexes.

### 2. Add TypeScript Type

In `dashboard/src/lib/supabase.ts`:

```typescript
export type MyTable = {
  id: string;
  company_id: string;
  name: string;
  data: Json;
  created_at: string;
  updated_at: string;
};
```

### 3. Add Python Operations

In `vincera/knowledge/supabase_client.py`, add methods to `SupabaseManager`:

```python
def create_my_record(self, company_id: str, name: str, data: dict) -> dict:
    return self._client.table("my_table").insert({
        "company_id": company_id,
        "name": name,
        "data": data,
    }).execute().data[0]

def query_my_records(self, company_id: str) -> list[dict]:
    return self._client.table("my_table").select("*").eq(
        "company_id", company_id
    ).order("created_at", desc=True).execute().data
```

## Code Style

### Python

- Follow existing patterns in `vincera/agents/base.py` and `vincera/core/orchestrator.py`
- Use `from __future__ import annotations` at the top of every file
- Use `TYPE_CHECKING` imports for circular dependency avoidance
- Async methods throughout — all agent methods are `async`
- Pydantic `BaseModel` for structured data
- `logging.getLogger(__name__)` in every module

### TypeScript

- Follow existing component patterns in `dashboard/src/components/`
- `"use client"` directive on all components using hooks or state
- Framer Motion for animations
- Tailwind CSS for styling
- Lucide React for icons

### Tests

- Mock all I/O boundaries (Supabase, LLM, filesystem)
- Use `unittest.mock.AsyncMock` for async methods
- Test observable behavior, not implementation details
- Use `asyncio.run()` wrapper for async tests
- One test file per module: `tests/test_<module>.py`

## Pull Request Process

1. Run the full test suite before submitting:
   ```bash
   cd Vincera && source .venv/bin/activate && pytest -v
   ```
2. Verify the dashboard builds:
   ```bash
   cd dashboard && npm run build
   ```
3. One feature per PR
4. Include tests for new functionality
5. Update relevant documentation if behavior changes
