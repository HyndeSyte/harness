"""The build identifier (0.24.0, eighth and ninth rounds): one hash over every file the App ships.

Ninth round: not only the Python package but the Dockerfile, config.yaml and rootfs (the s6 run and
finish scripts) too, so a change to any shipped file makes a new build, and the install step
(migrate.install) runs again for it. The image computes it once at build time (the Dockerfile runs
this file and keeps the answer in /opt/harness/BUILD_ID); from a source tree, calendar_change.app_build
computes the same hash over the same files. Standard library only, and no package imports, so the
Dockerfile can run it before the package is importable.

    python3 buildid.py <the App folder: Dockerfile, config.yaml, rootfs> <the folder holding the package>
"""
from __future__ import annotations

import hashlib
import pathlib
import sys

SKIP_DIRS = {"__pycache__"}
SKIP_FILES = {"BUILD_ID"}


def files(addon: pathlib.Path | None, app: pathlib.Path) -> list[tuple[str, pathlib.Path]]:
    """Each shipped file under its path as the source tree names it: app/..., rootfs/..., Dockerfile and
    config.yaml. Sorted, so the hash doesn't depend on the order a directory lists in."""
    out: list[tuple[str, pathlib.Path]] = []

    def walk(root: pathlib.Path, prefix: str) -> None:
        if not root.is_dir():
            return
        for f in root.rglob("*"):
            rel = f.relative_to(root)
            if f.is_file() and not (set(rel.parts) & SKIP_DIRS) and f.name not in SKIP_FILES \
                    and f.suffix not in (".pyc", ".pyo"):
                out.append((f"{prefix}/{rel.as_posix()}", f))
    walk(app, "app")
    if addon is not None:
        walk(addon / "rootfs", "rootfs")
        for name in ("Dockerfile", "config.yaml"):
            if (addon / name).is_file():
                out.append((name, addon / name))
    return sorted(out)


def compute(addon: pathlib.Path | None, app: pathlib.Path) -> str:
    h = hashlib.sha256()
    for name, f in files(addon, app):
        h.update(name.encode() + b"\0" + f.read_bytes() + b"\0")
    return h.hexdigest()[:16]


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: buildid.py <app folder with Dockerfile> <folder holding the package>")
    print(compute(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])))
