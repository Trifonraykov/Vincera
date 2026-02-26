"""Vincera Bot — main CLI entry point."""

from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
from pathlib import Path

from rich.console import Console
from rich.table import Table

console = Console()


# ------------------------------------------------------------------
# CLI parser
# ------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Build the argument parser for Vincera Bot."""
    parser = argparse.ArgumentParser(
        prog="vincera",
        description="Vincera Bot — autonomous AI agent platform",
    )
    parser.add_argument("--run", action="store_true", default=True, help="Start the agent loop (default)")
    parser.add_argument("--status", action="store_true", default=False, help="Print current agent statuses")
    parser.add_argument("--pause", action="store_true", default=False, help="Pause all agents")
    parser.add_argument("--resume", action="store_true", default=False, help="Resume all agents")
    parser.add_argument("--stop", action="store_true", default=False, help="Stop a running instance")
    parser.add_argument("--install-service", action="store_true", default=False, help="Install as system service")
    parser.add_argument("--config", type=str, default=".env", help="Path to .env file")
    return parser


# ------------------------------------------------------------------
# Command handlers
# ------------------------------------------------------------------


def handle_status(state) -> None:
    """Print agent statuses and pause state."""
    rows = state._db.query("SELECT * FROM agent_statuses")
    paused = state.is_paused()

    table = Table(title="Vincera Agent Statuses")
    table.add_column("Agent", style="cyan")
    table.add_column("Status", style="bold")
    table.add_column("Task")
    table.add_column("Updated")

    for row in rows:
        table.add_row(
            row["agent_name"],
            row["status"],
            row["current_task"],
            row.get("updated_at", ""),
        )

    console.print(table)
    console.print(f"\nSystem paused: [bold]{'Yes' if paused else 'No'}[/bold]")


def handle_pause(state) -> None:
    """Set the paused flag."""
    state.set_paused(True)
    console.print("[yellow]System paused.[/yellow]")


def handle_resume(state) -> None:
    """Clear the paused flag."""
    state.set_paused(False)
    console.print("[green]System resumed.[/green]")


def handle_run(state, settings, *, shutdown_event: threading.Event | None = None) -> None:
    """Start the main agent loop.

    Args:
        state: GlobalState instance.
        settings: VinceraSettings instance.
        shutdown_event: Optional event for testing. If None, creates one with signal handlers.
    """
    home_dir: Path = settings.home_dir
    installed_marker = home_dir / ".installed"

    # First-run detection
    if not installed_marker.exists():
        console.print("[yellow]Vincera Bot is not installed. Run the installer first:[/yellow]")
        console.print("  python -m vincera.installer")
        return

    # PID file
    pid_path = home_dir / "vincera.pid"
    pid_path.write_text(str(os.getpid()), encoding="utf-8")

    # Shutdown event
    shutdown = shutdown_event or threading.Event()

    if shutdown_event is None:
        def _signal_handler(signum, frame):
            shutdown.set()

        signal.signal(signal.SIGTERM, _signal_handler)
        signal.signal(signal.SIGINT, _signal_handler)

    # Main loop (stub — agents will be added in later stages)
    if not shutdown.is_set():
        shutdown.wait(timeout=1 if shutdown_event else 60)

    # Clean shutdown
    state.save_snapshot(home_dir / "core" / "snapshot.json")

    if pid_path.exists():
        pid_path.unlink()


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------


def main() -> None:
    """Main entry point for Vincera Bot."""
    parser = build_parser()
    args = parser.parse_args()

    # Lazy imports to avoid circular dependencies and speed up CLI
    from vincera.config import get_settings
    from vincera.core.state import GlobalState
    from vincera.knowledge.supabase_client import SupabaseManager
    from vincera.utils.logging import setup_logging

    settings = get_settings()
    setup_logging(settings.logs_dir)

    sb = SupabaseManager(
        supabase_url=settings.supabase_url,
        supabase_key=settings.supabase_service_key,
        company_id=settings.company_id or "",
    )
    state = GlobalState(
        db_path=settings.home_dir / "core" / "state.db",
        supabase_manager=sb,
    )

    if args.status:
        handle_status(state)
    elif args.pause:
        handle_pause(state)
    elif args.resume:
        handle_resume(state)
    elif args.stop:
        _handle_stop(settings)
    elif args.install_service:
        _handle_install_service()
    else:
        handle_run(state, settings)


def _handle_stop(settings) -> None:
    """Stop a running Vincera instance via PID file."""
    pid_path = settings.home_dir / "vincera.pid"
    if not pid_path.exists():
        console.print("[yellow]No running instance found.[/yellow]")
        return
    try:
        pid = int(pid_path.read_text().strip())
        os.kill(pid, signal.SIGTERM)
        console.print(f"[green]Sent SIGTERM to PID {pid}.[/green]")
    except (ProcessLookupError, ValueError):
        console.print("[yellow]Process not found. Removing stale PID file.[/yellow]")
        pid_path.unlink(missing_ok=True)


def _handle_install_service() -> None:
    """Install Vincera as a system service (stub)."""
    console.print("[yellow]Service installation not yet implemented.[/yellow]")


if __name__ == "__main__":
    main()
