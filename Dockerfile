FROM node:20-slim AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM python:3.12-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && pip install -q uv && useradd -u 1000 -m studio \
 && mkdir -p /opt/foundry-studio/backend && chown -R 1000:1000 /opt/foundry-studio
WORKDIR /opt/foundry-studio/backend
COPY --chown=1000:1000 backend/pyproject.toml backend/uv.lock ./
RUN UV_PYTHON_DOWNLOADS=never uv sync --no-dev --frozen --no-install-project -q
COPY --chown=1000:1000 backend ./
COPY --chown=1000:1000 vendor /opt/foundry-studio/vendor
COPY --chown=1000:1000 --from=frontend /src/dist /opt/foundry-studio/frontend/dist
RUN UV_PYTHON_DOWNLOADS=never uv sync --no-dev --frozen -q
USER 1000
ENV STUDIO_WORKSPACE=/opt/foundry-studio/workspace PATH=/opt/foundry-studio/backend/.venv/bin:$PATH
CMD ["uvicorn", "foundry_studio.app:app", "--host", "0.0.0.0", "--port", "8000"]
