"""Vincera platform abstraction layer.

Re-exports os_type for backwards compatibility and provides
get_platform_service() factory.
"""

from vincera.platform._base import PlatformService, ServiceStatus
from vincera.platform._detection import OSType, os_type
from vincera.platform._models import (
    DiscoveryResult,
    ProcessInfo,
    ShareInfo,
    SoftwareInfo,
    TaskInfo,
)


def get_platform_service() -> PlatformService:
    """Return the PlatformService subclass for the current OS."""
    if os_type == "macos":
        from vincera.platform._macos import MacOSPlatformService

        return MacOSPlatformService()
    elif os_type == "linux":
        from vincera.platform._linux import LinuxPlatformService

        return LinuxPlatformService()
    elif os_type == "windows":
        from vincera.platform._windows import WindowsPlatformService

        return WindowsPlatformService()
    else:
        raise RuntimeError(f"No platform service for: {os_type}")


__all__ = [
    "os_type",
    "OSType",
    "PlatformService",
    "ServiceStatus",
    "get_platform_service",
    "DiscoveryResult",
    "SoftwareInfo",
    "ProcessInfo",
    "ShareInfo",
    "TaskInfo",
]
