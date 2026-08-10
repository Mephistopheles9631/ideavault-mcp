"""Cheap git-based staleness signal -- not a full watcher/daemon, just a
fast subprocess check the server can afford to run on every query tool
call. Returns None (never triggers a refresh) for non-git directories.
"""

import hashlib
import subprocess
from pathlib import Path


def git_signature(root: Path) -> str | None:
    if not (root / ".git").exists():
        return None
    try:
        head = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=3,
        )
        if head.returncode != 0:
            return None
        status = subprocess.run(
            ["git", "-C", str(root), "status", "--porcelain"],
            capture_output=True, text=True, timeout=3,
        )
        dirty_hash = hashlib.sha1(status.stdout.encode()).hexdigest()
        return f"{head.stdout.strip()}|{dirty_hash}"
    except (subprocess.SubprocessError, OSError):
        return None
