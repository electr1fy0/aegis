"""Run the local Aegis API service."""

from __future__ import annotations

import logging
import os

import uvicorn

logger = logging.getLogger("aegis.server")


def main() -> None:
    host = os.environ.get("AEGIS_HOST", "127.0.0.1")
    host = host.strip()
    if not host:
        raise SystemExit("AEGIS_HOST must be a nonblank host name or IP address.")
    raw_port = os.environ.get("AEGIS_PORT", "8000")
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise SystemExit("AEGIS_PORT must be an integer from 1 through 65535.") from exc
    if not 1 <= port <= 65535:
        raise SystemExit("AEGIS_PORT must be an integer from 1 through 65535.")
    try:
        uvicorn.run("backend.aegis.api:app", host=host, port=port, reload=False)
    except OSError as exc:
        logger.error("Unable to start Aegis on %s:%s (%s)", host, port, type(exc).__name__)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
