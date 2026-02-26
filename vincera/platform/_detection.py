"""Platform detection for Vincera Bot."""

import platform as _platform
from typing import Literal

OSType = Literal["macos", "linux", "windows"]


def _detect_os() -> OSType:
    """Detect the current operating system."""
    system = _platform.system().lower()
    if system == "darwin":
        return "macos"
    elif system == "linux":
        return "linux"
    elif system == "windows":
        return "windows"
    else:
        raise RuntimeError(f"Unsupported operating system: {system}")


os_type: OSType = _detect_os()
