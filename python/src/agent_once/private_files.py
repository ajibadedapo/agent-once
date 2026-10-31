from __future__ import annotations

import os

PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600


def ensure_private_directory(path: str) -> None:
    os.makedirs(path or ".", mode=PRIVATE_DIRECTORY_MODE, exist_ok=True)


def open_private_file(path: str) -> int:
    return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, PRIVATE_FILE_MODE)


def ensure_private_file(path: str) -> None:
    os.close(open_private_file(path))
