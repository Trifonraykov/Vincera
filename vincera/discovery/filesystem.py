"""Filesystem mapper: directory trees, project detection. Names only — never reads file contents."""

from __future__ import annotations

import logging
import os
import platform
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel

logger = logging.getLogger(__name__)

_SKIP_NAMES = frozenset({
    "node_modules", "__pycache__", ".git", "venv", ".venv", "env",
    ".env", "$Recycle.Bin", "System Volume Information",
})

_PROJECT_MARKERS = {
    "package.json": ("node", "javascript"),
    "requirements.txt": ("python", "python"),
    "pyproject.toml": ("python", "python"),
    "setup.py": ("python", "python"),
    "docker-compose.yml": ("docker", "multi"),
    "docker-compose.yaml": ("docker", "multi"),
    "Dockerfile": ("docker", "multi"),
    ".sln": ("dotnet", "csharp"),
    "pom.xml": ("maven", "java"),
    "build.gradle": ("gradle", "java"),
    "Cargo.toml": ("rust", "rust"),
    "go.mod": ("go", "go"),
    "Makefile": ("make", "c/c++"),
    "Gemfile": ("ruby", "ruby"),
    "composer.json": ("composer", "php"),
}


class DirectoryEntry(BaseModel):
    """A single file or directory entry."""

    name: str
    is_dir: bool
    extension: str | None = None
    size_bytes: int = 0
    last_modified: str = ""
    path: str = ""
    children: list["DirectoryEntry"] = []


class DirectoryTree(BaseModel):
    """A mapped directory tree."""

    root: str
    entries: list[DirectoryEntry] = []
    total_files: int = 0
    total_dirs: int = 0


class ProjectInfo(BaseModel):
    """A detected project structure."""

    path: str
    project_type: str
    language: str
    framework: str | None = None


class FilesystemMapper:
    """Maps directory trees. Names only — NEVER reads file contents."""

    async def map_directory(self, path: Path, max_depth: int = 4) -> DirectoryTree:
        """Walk a directory tree up to max_depth. Uses os.stat() only."""
        entries, total_files, total_dirs = self._walk(path, max_depth, 0)
        return DirectoryTree(
            root=str(path),
            entries=entries,
            total_files=total_files,
            total_dirs=total_dirs,
        )

    def _walk(self, path: Path, max_depth: int, current_depth: int) -> tuple[list[DirectoryEntry], int, int]:
        """Recursive directory walk. Returns (entries, file_count, dir_count)."""
        entries: list[DirectoryEntry] = []
        total_files = 0
        total_dirs = 0

        try:
            with os.scandir(str(path)) as it:
                for item in sorted(it, key=lambda e: e.name):
                    name = item.name

                    # Skip hidden and known noisy dirs
                    if name.startswith(".") or name in _SKIP_NAMES:
                        continue

                    try:
                        stat = item.stat(follow_symlinks=False)
                    except (PermissionError, OSError):
                        continue

                    is_dir = item.is_dir(follow_symlinks=False)
                    ext = None if is_dir else (Path(name).suffix or None)
                    modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()

                    entry = DirectoryEntry(
                        name=name,
                        is_dir=is_dir,
                        extension=ext,
                        size_bytes=stat.st_size if not is_dir else 0,
                        last_modified=modified,
                        path=str(Path(path) / name),
                    )

                    if is_dir:
                        total_dirs += 1
                        if current_depth < max_depth:
                            children, cf, cd = self._walk(Path(path) / name, max_depth, current_depth + 1)
                            entry.children = children
                            total_files += cf
                            total_dirs += cd
                    else:
                        total_files += 1

                    entries.append(entry)
        except PermissionError:
            logger.warning("Permission denied: %s", path)
        except OSError as exc:
            logger.warning("Error scanning %s: %s", path, exc)

        return entries, total_files, total_dirs

    async def map_standard_paths(self) -> list[DirectoryTree]:
        """Map OS-specific standard directories."""
        system = platform.system()
        candidates: list[Path] = []

        if system == "Darwin":
            home = Path.home()
            candidates = [
                home / "Documents", home / "Desktop",
                Path("/Applications"),
            ]
            # Add /Volumes/* (non-root)
            volumes = Path("/Volumes")
            if volumes.exists():
                try:
                    candidates.extend(
                        p for p in volumes.iterdir()
                        if p.is_dir() and p.name != "Macintosh HD"
                    )
                except PermissionError:
                    pass
        elif system == "Linux":
            home = Path.home()
            candidates = [
                home / "Documents", home / "Desktop",
                Path("/opt"), Path("/var/www"), Path("/srv"),
            ]
        elif system == "Windows":
            home = Path.home()
            candidates = [
                home / "Documents", home / "Desktop",
                home / "OneDrive",
            ]
            for drive_letter in "DEF":
                drive = Path(f"{drive_letter}:\\")
                if drive.exists():
                    candidates.append(drive)

        trees: list[DirectoryTree] = []
        for path in candidates:
            if path.exists():
                try:
                    tree = await self.map_directory(path, max_depth=3)
                    trees.append(tree)
                except Exception as exc:
                    logger.warning("Failed to map %s: %s", path, exc)

        return trees

    async def identify_project_structures(self, trees: list[DirectoryTree] | None = None) -> list[ProjectInfo]:
        """Detect project structures from marker files in mapped trees."""
        if trees is None:
            trees = await self.map_standard_paths()

        projects: list[ProjectInfo] = []
        seen_paths: set[str] = set()

        for tree in trees:
            self._find_projects(tree.entries, projects, seen_paths)

        return projects

    def _find_projects(
        self,
        entries: list[DirectoryEntry],
        projects: list[ProjectInfo],
        seen: set[str],
    ) -> None:
        """Recursively find project markers in directory entries."""
        for entry in entries:
            if not entry.is_dir:
                # Check if this file is a project marker
                for marker, (proj_type, lang) in _PROJECT_MARKERS.items():
                    if entry.name == marker or entry.name.endswith(marker):
                        parent = str(Path(entry.path).parent)
                        if parent not in seen:
                            seen.add(parent)
                            projects.append(ProjectInfo(
                                path=parent,
                                project_type=proj_type,
                                language=lang,
                            ))
            if entry.children:
                self._find_projects(entry.children, projects, seen)

    async def detect_erp_structures(self) -> list[dict]:
        """Look for ERP/accounting data structures."""
        erp_patterns: dict[str, list[str]] = {
            "quickbooks": ["*.QBW", "*.QBB", "*.QBX"],
            "sage": ["Sage*"],
            "xero": ["Xero*", "xero-export*"],
            "freshbooks": ["FreshBooks*", "freshbooks-export*"],
            "sap": ["SAP*", "sap*"],
        }
        found: list[dict] = []
        home = Path.home()
        search_dirs = [home / "Documents", home / "Desktop", home / "Downloads"]

        for search_dir in search_dirs:
            if not search_dir.exists():
                continue
            for erp_name, patterns in erp_patterns.items():
                for pattern in patterns:
                    try:
                        matches = list(search_dir.rglob(pattern))
                        for match in matches[:5]:
                            found.append({
                                "erp": erp_name,
                                "path": str(match),
                                "name": match.name,
                            })
                    except (PermissionError, OSError):
                        continue

        return found

    @staticmethod
    def get_summary(trees: list[DirectoryTree]) -> dict:
        """Summarize a collection of directory trees."""
        total_files = sum(t.total_files for t in trees)
        total_dirs = sum(t.total_dirs for t in trees)

        ext_counter: Counter[str] = Counter()
        dir_sizes: list[tuple[str, int]] = []

        def _count_extensions(entries: list[DirectoryEntry]) -> None:
            for entry in entries:
                if not entry.is_dir and entry.extension:
                    ext_counter[entry.extension] += 1
                if entry.is_dir:
                    child_files = sum(1 for c in entry.children if not c.is_dir)
                    if child_files > 0:
                        dir_sizes.append((entry.path, child_files))
                if entry.children:
                    _count_extensions(entry.children)

        for tree in trees:
            _count_extensions(tree.entries)

        files_by_extension = dict(ext_counter.most_common(10))
        largest_dirs = sorted(dir_sizes, key=lambda x: x[1], reverse=True)[:10]

        return {
            "total_files": total_files,
            "total_dirs": total_dirs,
            "files_by_extension": files_by_extension,
            "largest_directories": [{"path": p, "file_count": c} for p, c in largest_dirs],
        }
