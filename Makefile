.PHONY: setup dev demo demo-reset test test-backend test-frontend e2e build serve

setup:            ## install everything (foundry submodule, Python and Node deps)
	git submodule update --init
	cd backend && uv sync
	cd frontend && npm ci

dev:              ## backend + frontend against GitLab (needs GITLAB_TOKEN)
	./scripts/dev.sh

demo:             ## same, against local stand-ins for skywalker and PipelineDeploys
	STUDIO_FAKE_GITLAB=demo ./scripts/dev.sh

demo-reset:       ## recreate the demo repos
	cd backend && uv run python -m foundry_studio.demo init

test: test-backend test-frontend

test-backend:
	cd backend && uv run pytest

test-frontend:
	cd frontend && npx tsc -b && npx vitest run

e2e:              ## Playwright, against the offline demo
	cd frontend && npx playwright test

build:            ## production frontend bundle, served by the backend
	cd frontend && npm run build

serve: build      ## one process on :8000 (no auto-reload)
	cd backend && uv run uvicorn foundry_studio.app:app --host 127.0.0.1 --port 8000
