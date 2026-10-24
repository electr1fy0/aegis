.PHONY: setup backend frontend test coverage build lint verify

setup:
	uv venv --python python3 .venv
	uv pip sync --python .venv/bin/python requirements-dev.lock
	cd frontend && bun install --frozen-lockfile

backend:
	.venv/bin/python -m backend.aegis

frontend:
	cd frontend && bun run dev

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
