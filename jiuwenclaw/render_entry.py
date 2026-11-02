"""Render entrypoint for running Deep Canvas as a single public service.

This starts:
- the internal JiuwenClaw app stack (AgentServer + Gateway/WebSocket)
- the public static/proxy web server on Render's public PORT

The web server serves the built frontend and proxies `/ws`, `/api`, and
`/file-api` over the same origin, which keeps the current frontend behavior
intact for production hosting.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import shutil
from pathlib import Path


def _start_process(name: str, cmd: list[str], cwd: Path) -> subprocess.Popen[bytes]:
    print(f"[render-entry] starting {name}: {' '.join(cmd)} (cwd={cwd})", flush=True)
    return subprocess.Popen(cmd, cwd=str(cwd))


def _terminate_processes(processes: dict[str, subprocess.Popen[bytes]]) -> None:
    for name, proc in processes.items():
        if proc.poll() is None:
            print(f"[render-entry] terminating {name} (pid={proc.pid})", flush=True)
            proc.terminate()

    deadline = time.time() + 20
    while time.time() < deadline:
        if all(proc.poll() is not None for proc in processes.values()):
            return
        time.sleep(0.2)

    for name, proc in processes.items():
        if proc.poll() is None:
            print(f"[render-entry] killing {name} (pid={proc.pid})", flush=True)
            proc.kill()


def _ensure_workspace_dist(repo_root: Path) -> None:
    """Copy the built frontend bundle into the mounted workspace if needed."""
    source_dist = repo_root / "jiuwenclaw" / "web" / "dist"
    if not source_dist.exists():
        print(f"[render-entry] frontend dist missing at {source_dist}", flush=True)
        return

    workspace_root = Path(os.getenv("HOME", "/var/data")) / ".jiuwenclaw"
    target_dist = workspace_root / "web" / "dist"
    if target_dist.exists():
        return

    target_dist.parent.mkdir(parents=True, exist_ok=True)
    print(f"[render-entry] staging frontend dist to {target_dist}", flush=True)
    shutil.copytree(source_dist, target_dist, dirs_exist_ok=True)


def main() -> None:
    python = sys.executable
    repo_root = Path(__file__).resolve().parent.parent
    _ensure_workspace_dist(repo_root)

    public_port = os.getenv("PORT", "10000")
    internal_web_host = os.getenv("WEB_HOST", "127.0.0.1")
    internal_web_port = os.getenv("WEB_PORT", "19000")
    proxy_target = os.getenv(
        "APP_WEB_PROXY_TARGET",
        f"http://{internal_web_host}:{internal_web_port}",
    )

    processes: dict[str, subprocess.Popen[bytes]] = {}
    stopping = False

    def _shutdown(signum: int, _frame) -> None:
        nonlocal stopping
        if stopping:
            return
        stopping = True
        print(f"[render-entry] received signal {signum}, shutting down...", flush=True)
        _terminate_processes(processes)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    try:
        processes["app"] = _start_process(
            "app",
            [python, "-m", "jiuwenclaw.app"],
            repo_root,
        )
        time.sleep(1.0)
        processes["web"] = _start_process(
            "web",
            [
                python,
                "-m",
                "jiuwenclaw.app_web",
                "--host",
                "0.0.0.0",
                "--port",
                str(public_port),
                "--proxy-target",
                proxy_target,
            ],
            repo_root,
        )

        while True:
            for name, proc in processes.items():
                code = proc.poll()
                if code is not None:
                    print(f"[render-entry] {name} exited with code {code}", flush=True)
                    raise SystemExit(code)
            time.sleep(0.5)
    finally:
        _terminate_processes(processes)


if __name__ == "__main__":
    main()
