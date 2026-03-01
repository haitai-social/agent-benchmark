from __future__ import annotations

import logging

from infrastructure.config import load_settings
from .worker import ConsumerWorker


def run() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = load_settings()
    worker = ConsumerWorker(settings)
    worker.start()


if __name__ == "__main__":
    run()
