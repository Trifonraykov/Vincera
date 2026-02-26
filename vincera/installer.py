"""Interactive CLI installer for Vincera Bot."""

from __future__ import annotations

import os
from pathlib import Path

import httpx
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt
from supabase import create_client

from vincera.utils.crypto import encrypt, is_encrypted

console = Console()

_OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"


# ------------------------------------------------------------------
# Validation helpers
# ------------------------------------------------------------------


def validate_openrouter_key(key: str) -> bool:
    """Check that an OpenRouter API key is valid via GET /api/v1/models."""
    try:
        resp = httpx.get(
            _OPENROUTER_MODELS_URL,
            headers={"Authorization": f"Bearer {key}"},
            timeout=15,
        )
        return resp.status_code == 200
    except Exception:
        return False


def validate_supabase_connection(url: str, anon_key: str) -> bool:
    """Verify we can connect to Supabase with the given URL and anon key."""
    try:
        client = create_client(url, anon_key)
        client.table("companies").select("id").limit(1).execute()
        return True
    except Exception:
        return False


# ------------------------------------------------------------------
# Env file writing
# ------------------------------------------------------------------


def _write_env_file(env_path: Path, values: dict[str, str]) -> None:
    """Write a .env file from a dict, encrypting sensitive fields."""
    sensitive_keys = {"OPENROUTER_API_KEY", "SUPABASE_SERVICE_KEY"}
    lines: list[str] = []
    for key, val in values.items():
        if key in sensitive_keys and not is_encrypted(val):
            val = encrypt(val)
        lines.append(f"{key}={val}")
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ------------------------------------------------------------------
# Main installer flow
# ------------------------------------------------------------------


def run_installer(
    non_interactive: bool = False,
    env_path: Path | None = None,
) -> bool:
    """Run the Vincera Bot installer.

    Args:
        non_interactive: If True, read all values from env vars instead of prompting.
        env_path: Path to write the .env file. Defaults to CWD/.env.

    Returns:
        True on success, False on failure.
    """
    env_path = env_path or Path(".env")

    if not non_interactive:
        console.print(Panel("[bold cyan]Vincera Bot Installer[/bold cyan]", expand=False))

    # 1. Gather values
    if non_interactive:
        company_name = os.environ.get("COMPANY_NAME", "")
        agent_name = os.environ.get("AGENT_NAME", "vincera")
        openrouter_key = os.environ.get("OPENROUTER_API_KEY", "")
        supabase_url = os.environ.get("SUPABASE_URL", "")
        supabase_anon_key = os.environ.get("SUPABASE_ANON_KEY", "")
        supabase_service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
        home_dir = os.environ.get("HOME_DIR", str(Path("~/VinceraHQ").expanduser()))
    else:
        company_name = Prompt.ask("[bold]Company name[/bold]")
        agent_name = Prompt.ask("[bold]Agent name[/bold]", default="vincera")
        openrouter_key = Prompt.ask("[bold]OpenRouter API key[/bold]")
        supabase_url = Prompt.ask("[bold]Supabase URL[/bold]")
        supabase_anon_key = Prompt.ask("[bold]Supabase Anon Key[/bold]")
        supabase_service_key = Prompt.ask("[bold]Supabase Service Key[/bold]")
        home_dir = Prompt.ask("[bold]Home directory[/bold]", default=str(Path("~/VinceraHQ").expanduser()))

    if not company_name:
        console.print("[red]Company name is required.[/red]")
        return False

    # 2. Validate OpenRouter key
    if not non_interactive:
        console.print("Validating OpenRouter API key…")
    if not validate_openrouter_key(openrouter_key):
        console.print("[red]OpenRouter API key validation failed.[/red]")
        return False

    # 3. Validate Supabase
    if not non_interactive:
        console.print("Validating Supabase connection…")
    if not validate_supabase_connection(supabase_url, supabase_anon_key):
        console.print("[red]Supabase connection validation failed.[/red]")
        return False

    # 4. Register company
    try:
        sb_client = create_client(supabase_url, supabase_anon_key)
        result = (
            sb_client.table("companies")
            .insert({"name": company_name, "agent_name": agent_name})
            .execute()
        )
        company_id = result.data[0]["id"] if result.data else None
    except Exception as exc:
        console.print(f"[red]Failed to register company: {exc}[/red]")
        return False

    # 5. Write .env file
    env_values = {
        "COMPANY_NAME": company_name,
        "AGENT_NAME": agent_name,
        "OPENROUTER_API_KEY": openrouter_key,
        "SUPABASE_URL": supabase_url,
        "SUPABASE_ANON_KEY": supabase_anon_key,
        "SUPABASE_SERVICE_KEY": supabase_service_key,
        "HOME_DIR": home_dir,
    }
    if company_id:
        env_values["COMPANY_ID"] = company_id

    _write_env_file(env_path, env_values)

    # 6. Create directory tree
    home = Path(os.path.expanduser(home_dir))
    for subdir in ("core", "agents", "scripts", "knowledge", "inbox", "outbox", "logs", "deployments", "training"):
        (home / subdir).mkdir(parents=True, exist_ok=True)

    # 7. Mark as installed
    (home / ".installed").touch()

    if not non_interactive:
        console.print(Panel("[bold green]Installation complete![/bold green]", expand=False))

    return True
