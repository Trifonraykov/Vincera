"""Fernet encryption utilities with machine-derived key.

The encryption key is derived from the machine's hostname and current
username using PBKDF2-HMAC-SHA256. Encrypted values are tied to the
specific machine and user account.
"""

from __future__ import annotations

import base64
import getpass
import socket
from functools import lru_cache

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ENCRYPTED_PREFIX = "ENC:"

_FIXED_SALT = b"vincera-bot-config-encryption-v1"
_PBKDF2_ITERATIONS = 600_000


@lru_cache(maxsize=1)
def _derive_key() -> bytes:
    """Derive a Fernet key from machine identity (hostname + username)."""
    hostname = socket.gethostname()
    username = getpass.getuser()
    password = f"{hostname}:{username}".encode("utf-8")

    kdf = PBKDF2HMAC(
        algorithm=SHA256(),
        length=32,
        salt=_FIXED_SALT,
        iterations=_PBKDF2_ITERATIONS,
    )
    raw_key = kdf.derive(password)
    return base64.urlsafe_b64encode(raw_key)


def get_fernet() -> Fernet:
    """Get a Fernet instance using the machine-derived key."""
    return Fernet(_derive_key())


def encrypt(plaintext: str) -> str:
    """Encrypt a plaintext string, returning it with the ENC: prefix."""
    if plaintext.startswith(ENCRYPTED_PREFIX):
        return plaintext  # Already encrypted
    f = get_fernet()
    token = f.encrypt(plaintext.encode("utf-8"))
    return f"{ENCRYPTED_PREFIX}{token.decode('ascii')}"


def decrypt(value: str) -> str:
    """Decrypt a value if it has the ENC: prefix, otherwise return as-is."""
    if not value.startswith(ENCRYPTED_PREFIX):
        return value
    ciphertext = value[len(ENCRYPTED_PREFIX):]
    f = get_fernet()
    return f.decrypt(ciphertext.encode("ascii")).decode("utf-8")


def is_encrypted(value: str) -> bool:
    """Check whether a value carries the ENC: prefix."""
    return value.startswith(ENCRYPTED_PREFIX)
