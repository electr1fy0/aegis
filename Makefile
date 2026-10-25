.PHONY: setup backend backend-semantic frontend dev dev-semantic preflight semantic-setup evaluate evaluate-semantic test coverage build lint verify

setup:
	uv venv --python python3 .venv
	uv pip sync --python .venv/bin/python requirements-dev.lock
	cd frontend && bun install --frozen-lockfile

backend:
	.venv/bin/python -m backend.aegis

frontend:
	cd frontend && bun run dev

dev:
	.venv/bin/python scripts/dev.py

dev-semantic:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv-semantic/bin/python -m backend.aegis.maintenance preflight --require-semantic
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv-semantic/bin/python scripts/dev.py

preflight:
	.venv/bin/python -m backend.aegis.maintenance preflight

semantic-setup:
	uv venv --allow-existing --python .venv/bin/python .venv-semantic
	uv pip sync --python .venv-semantic/bin/python requirements-semantic.lock
	.venv-semantic/bin/python -m backend.aegis.maintenance prepare-model

backend-semantic:
	.venv-semantic/bin/python -m backend.aegis

evaluate:
	.venv/bin/python -m backend.aegis.maintenance evaluate

evaluate-semantic:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv-semantic/bin/python -m backend.aegis.maintenance evaluate

test:
	.venv/bin/python -m pytest
	cd frontend && bun run test

coverage:
	.venv/bin/python -m pytest --cov --cov-report=term-missing --cov-report=json:coverage.json
	cd frontend && bun run coverage

build:
	cd frontend && bun run build

lint:
	.venv/bin/python -m ruff check .
	.venv/bin/python -m ruff format --check .

verify: lint coverage build
