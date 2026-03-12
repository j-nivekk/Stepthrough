.PHONY: backend-install frontend-install backend-dev frontend-dev test build

backend-install:
	cd backend && uv sync

frontend-install:
	cd frontend && npm install

backend-dev:
	cd backend && uv run uvicorn app.main:app --reload

frontend-dev:
	cd frontend && npm run dev

test:
	cd backend && uv run pytest

build:
	cd frontend && npm run build
