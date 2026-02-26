# Testing Guide

## Overview

Vincera tests mock all I/O boundaries (Supabase, LLM, filesystem) while wiring real business logic together. This validates that components integrate correctly without requiring network access or external services.

**Philosophy:** Mock the edges, test the wiring.

## Running Tests

```bash
cd Vincera
python -m pytest tests/ -v
```

Run a specific test file:

```bash
python -m pytest tests/test_e2e.py -v
python -m pytest tests/test_orchestrator.py -v
```

Run a single test class:

```bash
python -m pytest tests/test_e2e.py::TestGhostModeActivation -v
```

## Test Structure

```
tests/
  conftest.py          # Shared fixtures (mock_supabase, mock_llm, etc.)
  test_e2e.py          # E2E lifecycle scenarios (10 tests)
  test_orchestrator.py # Orchestrator unit tests
  test_ghost_mode.py   # Ghost mode unit tests
  test_discovery.py    # Discovery agent unit tests
  test_integration.py  # Integration tests
  test_builder.py      # Builder agent unit tests
```

**Unit tests** — test a single class in isolation with all dependencies mocked.

**E2E tests** (`test_e2e.py`) — wire multiple real classes together (Orchestrator + MessageHandler + GhostModeController) with only I/O boundaries mocked.

## Mocking Approach

### MockSupabase (`mock_supabase` fixture)

A `MagicMock` with all SupabaseManager methods pre-configured with sensible defaults:

| Method | Default Return |
|--------|---------------|
| `get_latest_brain_state` | `None` |
| `save_brain_state` | `{"id": "bs-1"}` |
| `send_message` | `{"id": "msg-1"}` |
| `log_event` | `{"id": "ev-1"}` |
| `get_company` | `{"authority_level": "ask_risky"}` |
| `resolve_decision` | `{"id": "dec-1"}` |
| `save_ghost_report` | `{"id": "gr-1"}` |
| `get_ghost_reports` | `[]` |
| `update_company` | `{"id": "comp-1"}` |
| `get_new_messages` | `[]` |

Override any method per-test: `mock_supabase.get_new_messages.return_value = [...]`

### MockLLM (`mock_llm` fixture)

All async methods return canned responses:
- `think` -> `"ok"`
- `think_structured` -> `{}`
- `think_with_tools` -> `"ok"`
- `research` -> `"ok"`

### When to use real classes

Use real classes when testing their internal logic (state transitions, routing, report generation). Use mocks for everything that touches the network or database.

- **Real:** `Orchestrator`, `MessageHandler`, `GhostModeController`, `MessagePoller`
- **Mocked:** `SupabaseManager`, `OpenRouterClient`, `GlobalState`, agents (unless testing agent-specific logic)

## Scenario Coverage

| # | Test | What's Verified |
|---|------|----------------|
| 1 | `test_agent_startup_lifecycle` | Fresh init sets phase to "installing"; restored init loads saved state |
| 2 | `test_discovery_narration_flow` | Discovery agent executes, phase transitions to "researching" |
| 3 | `test_ghost_mode_activation` | Real GhostModeController starts, sets `is_active`, notifies Supabase |
| 4 | `test_user_chat_routing` | MessageHandler routes builder/status/correction/system messages correctly |
| 5 | `test_decision_lifecycle` | Decision responses resolve decisions in Supabase |
| 6 | `test_ghost_report_generation` | Observations + would-haves compile into report, saved to Supabase |
| 7 | `test_orchestrator_ooda_full_cycle` | Full phase sequence: install -> discover -> research -> ghost -> active |
| 8 | `test_message_poller_dispatches` | Poller fetches messages and calls handler.handle() |
| 9 | `test_ghost_mode_end_summary` | Ghost end sends summary, resets state, updates company to active |
| 10 | `test_pause_resume_blocks_cycle` | Paused state blocks cycle; unpaused allows it |

## Adding New Tests

1. Use the `_run()` helper for async tests: `result = _run(some_coroutine())`
2. Use conftest fixtures: `mock_supabase`, `mock_llm`, `mock_state`, `mock_config`
3. Use `_mock_agent(name, status)` for agent mocks
4. Use `_build_full_system()` to wire everything together for E2E scenarios
5. Override specific mock returns per-test as needed
6. Group related tests in a class (e.g., `TestGhostModeActivation`)

## CI Notes

- No external services required — all I/O is mocked
- No environment variables needed (conftest fixtures handle test env)
- Tests run in < 5 seconds total
- No database, no network, no API keys
