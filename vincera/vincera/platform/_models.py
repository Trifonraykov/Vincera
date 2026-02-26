"""Pydantic models for platform discovery results."""

from __future__ import annotations

from typing import Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class SoftwareInfo(BaseModel):
    name: str
    version: str | None = None
    source: str  # "brew", "apt", "app_bundle", "pip", "npm", etc.


class ProcessInfo(BaseModel):
    pid: int
    name: str
    user: str | None = None
    cpu_percent: float | None = None
    memory_percent: float | None = None
    cmdline: list[str] = []


class ShareInfo(BaseModel):
    name: str
    path: str
    share_type: str  # "cifs", "nfs", "smb", "local", etc.
    remote: str | None = None


class TaskInfo(BaseModel):
    name: str
    schedule: str | None = None
    command: str | None = None
    status: str | None = None


class DiscoveryResult(BaseModel, Generic[T]):
    items: list[T]
    complete: bool = True
    errors: list[str] = []
