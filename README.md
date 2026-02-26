# Vincera Bot

Autonomous AI agent system that installs on a company's machine, maps the business, researches the industry, observes for 7 days, then deploys sub-agents to automate operations.

## What It Does

Vincera follows a structured pipeline: **Discovery** scans the company's systems (filesystems, databases, networks, spreadsheets) and builds a comprehensive company model. **Research** studies the industry and finds best practices, academic papers, and case studies relevant to the business. During a 7-day **Ghost Mode**, the system observes operations and generates daily reports on what it *would* automate — without touching anything.

After the observation period, Vincera transitions to **Active Mode**. The Orchestrator runs an OODA loop (Observe-Orient-Decide-Act), dispatching 7 specialized agents: Discovery, Research, Builder, Operator, Analyst, Unstuck, and Trainer. The Builder generates automation scripts that pass through a 4-stage deployment pipeline (sandbox, shadow, canary, full) with 6-check verification at each gate.

The **Dashboard** is the sole user interface — a Next.js application connected to Supabase. There is no separate chat app or webhook integration. All communication flows through Supabase: agents write messages and status updates, the dashboard reads them via Realtime subscriptions, and users send commands back through the messages table.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Next.js Dashboard                   │
│  (Agents, Brain View, Automations, Decisions,   │
│   Knowledge, Research, Ghost Mode, Logs)         │
└────────────────────┬────────────────────────────┘
                     │  Supabase Realtime + REST
                     ▼
┌─────────────────────────────────────────────────┐
│                 Supabase                         │
│  15 tables │ RLS policies │ Realtime │ Functions │
└────────────────────┬────────────────────────────┘
                     │  supabase-py (service role)
                     ▼
┌─────────────────────────────────────────────────┐
│              Vincera Agent (Python)              │
│  Orchestrator → 7 Agents → Verification →       │
│  Sandbox → Shadow → Canary → Full Deploy        │
└─────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+ and npm
- Docker (for sandbox execution)
- A [Supabase](https://supabase.com) project (free tier works)
- An [OpenRouter](https://openrouter.ai) API key

### 1. Clone and Install Agent

```bash
git clone <repo-url> && cd vincera-bot/Vincera
pip install -e .
```

### 2. Configure

```bash
vincera install
# Interactive setup: asks for Supabase URL, keys, OpenRouter key, company name
# Encrypts secrets with Fernet, stores in ~/VinceraHQ/config.json
```

### 3. Run Supabase Migrations

```bash
cd supabase
npx supabase link --project-ref <your-project-ref>
npx supabase db push
# Or manually: apply each file in supabase/migrations/ in order via SQL editor
```

### 4. Start the Agent

```bash
vincera start
# Installs as system service: systemd (Linux), launchd (macOS), NSSM (Windows)

# Or run directly:
python -m vincera.main
```

### 5. Start the Dashboard

```bash
cd ../dashboard
npm install
cp .env.local.example .env.local
# Edit .env.local with your Supabase URL and anon key (NOT service key)
npm run dev
# Open http://localhost:3000
```

## Running Tests

```bash
# Python agent tests (from Vincera/ directory)
cd Vincera
source .venv/bin/activate
pytest -v

# Dashboard build check
cd ../dashboard
npm run build
```

## Project Structure

```
Vincera/
├── vincera/                 # Python agent
│   ├── agents/              # 7 specialized agents + base class
│   ├── builder/             # Code generation, review, testing
│   ├── core/                # Orchestrator, authority, LLM, state
│   ├── discovery/           # System and business discovery
│   ├── execution/           # Sandbox, shadow, canary, deployment
│   ├── knowledge/           # Playbook and Supabase client
│   ├── research/            # Business research and validation
│   ├── training/            # Agent learning and corrections
│   ├── utils/               # Logging, errors, crypto, resources
│   ├── verification/        # 6-check verification pipeline
│   ├── config.py            # Pydantic settings with Fernet encryption
│   └── main.py              # CLI entry point
├── tests/                   # 553 tests
├── supabase/migrations/     # 17 SQL migration files
└── dashboard/               # Next.js dashboard
    ├── src/app/dashboard/   # 13 routes
    ├── src/components/      # 42 React components
    ├── src/hooks/           # 12 data-fetching hooks
    └── src/contexts/        # Global dashboard state
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — system design, agents, data layer, verification pipeline
- [Deployment Guide](docs/DEPLOYMENT.md) — Supabase, agent, and dashboard deployment
- [Contributing](docs/CONTRIBUTING.md) — adding agents, pages, and tables
- [Testing](docs/TESTING.md) — test structure, fixtures, and E2E scenarios

## License

See LICENSE file.
