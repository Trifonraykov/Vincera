"""Network discovery: shares and mapped drives."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from vincera.discovery.filesystem import FilesystemMapper
    from vincera.platform import PlatformService

logger = logging.getLogger(__name__)


class NetworkDiscovery:
    """Discovers network shares and maps their top-level contents."""

    def __init__(
        self,
        platform_service: "PlatformService",
        filesystem_mapper: "FilesystemMapper",
    ) -> None:
        self._platform = platform_service
        self._fs = filesystem_mapper

    async def discover_shares(self) -> list[dict]:
        """Discover network shares and map accessible ones."""
        result = self._platform.list_network_shares()
        shares: list[dict] = []

        for share in result.items:
            entry = share.model_dump()
            share_path = Path(share.path)

            if share_path.exists() and share_path.is_dir():
                try:
                    tree = await self._fs.map_directory(share_path, max_depth=2)
                    entry["directory_summary"] = {
                        "total_files": tree.total_files,
                        "total_dirs": tree.total_dirs,
                    }
                except Exception as exc:
                    logger.warning("Failed to map share %s: %s", share.path, exc)
                    entry["directory_summary"] = None
            else:
                entry["directory_summary"] = None

            shares.append(entry)

        return shares
