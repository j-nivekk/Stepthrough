# syntax=docker/dockerfile:1.7
#
# Stepthrough as one image: the built frontend, the API and the analysis, served on port 8000.
#
#   docker build -f docker/Dockerfile .                          # the image (last stage, `runtime`)
#   docker build -f docker/Dockerfile --build-arg WITH_OCR=true .  # with text recognition (amd64 only)
#   docker build -f docker/Dockerfile --target test .            # the backend test suite on top
#
# Everything the app writes goes to /data, which compose.yaml keeps on a named volume.

ARG PYTHON_IMAGE=python:3.12-slim-trixie
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.6.14

FROM ${UV_IMAGE} AS uv

# --- 1. Frontend: built once here, so Node never ships in the image --------------------------------------------
# Static files are the same on every platform, so this stage runs natively even in a multi-platform build.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY frontend/ ./
# The image's tag and commit (CI passes them; `edge` for builds of main, the version number for releases), so the app
# can say which build it is. Kept after the npm install, so a new commit does not reinstall the packages.
ARG VERSION=dev
ARG REVISION=unknown
# Empty means "the server this page came from", so one build works behind any domain.
ENV VITE_API_BASE_URL="" \
    VITE_BUILD_VERSION=${VERSION} \
    VITE_BUILD_REVISION=${REVISION}
RUN npm test && npm run build

# --- 2. Python packages, exactly as locked in uv.lock ----------------------------------------------------------
FROM ${PYTHON_IMAGE} AS python-deps
COPY --from=uv /uv /usr/local/bin/uv
# Precompiled bytecode makes the container start faster. Under emulation (an amd64 build on an ARM Mac) Python starts
# too slowly for uv's compile step; pass --build-arg COMPILE_BYTECODE=0 there.
ARG COMPILE_BYTECODE=1
ENV UV_COMPILE_BYTECODE=${COMPILE_BYTECODE} \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src/backend
COPY backend/pyproject.toml backend/uv.lock ./
ARG WITH_OCR=false
RUN --mount=type=cache,target=/root/.cache/uv \
    if [ "$WITH_OCR" = "true" ]; then groups="--group ocr"; else groups=""; fi; \
    uv sync --frozen --no-dev --no-install-project $groups

# --- 3. Shared base for the test and runtime stages ------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS base
# ffmpeg/ffprobe do the decoding and the working copy. OpenCV's wheel needs libGL and GLib (PaddleOCR requires
# that build rather than the headless one); PaddlePaddle needs OpenMP.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0t64 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10001 stepthrough \
    && useradd --system --uid 10001 --gid stepthrough --home-dir /data --no-create-home --shell /usr/sbin/nologin stepthrough \
    && mkdir /data \
    && chown stepthrough:stepthrough /data
COPY --from=python-deps /opt/venv /opt/venv
COPY backend/app /app/backend/app
COPY --from=frontend /src/frontend/dist /app/frontend
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/data \
    STEPTHROUGH_DEPLOYMENT=server \
    STEPTHROUGH_DATA_ROOT=/data \
    STEPTHROUGH_FRONTEND_DIR=/app/frontend
WORKDIR /app/backend

# --- 4. Tests: the same image plus pytest and the suite ---------------------------------------------------------
FROM base AS test
COPY --from=uv /uv /usr/local/bin/uv
COPY backend/pyproject.toml backend/uv.lock ./
RUN UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never uv sync --frozen --no-install-project --inexact
COPY backend/tests ./tests
# The suite expects the desktop defaults (its server-mode tests switch modes themselves), and makes its own data
# roots under /tmp; this one is only a fallback.
ENV STEPTHROUGH_DEPLOYMENT=local \
    STEPTHROUGH_FRONTEND_DIR="" \
    STEPTHROUGH_DATA_ROOT=/tmp/stepthrough-test-data
USER stepthrough
CMD ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider"]

# --- 5. Runtime (the default target) ---------------------------------------------------------------------------
FROM base AS runtime
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Stepthrough" \
      org.opencontainers.image.description="Turns screen recordings of apps into reviewable walkthrough steps." \
      org.opencontainers.image.source="https://github.com/j-nivekk/Stepthrough" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
# Which build this is, for /health (the app's own version number is in the code).
ENV STEPTHROUGH_BUILD=${VERSION} \
    STEPTHROUGH_REVISION=${REVISION}
USER stepthrough
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"]
# One worker: run progress and cancel signals live in this process's memory (app/services/jobs.py).
# Proxy headers are trusted from any address because compose publishes the port on 127.0.0.1 only, for the host's
# own nginx; change FORWARDED_ALLOW_IPS if the port is ever reachable from elsewhere.
ENV FORWARDED_ALLOW_IPS="*"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--no-server-header"]
