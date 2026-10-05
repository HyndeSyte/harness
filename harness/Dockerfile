# Pinned base image: Home Assistant's Alpine + Python, release 2026.08.0
# (python 3.13, alpine 3.24). It carries s6-overlay (hence init: false in
# config.yaml), CA certificates and tzdata.
ARG BUILD_FROM=ghcr.io/home-assistant/base-python:3.13-alpine3.24-2026.08.0
FROM ${BUILD_FROM}

# Nothing is downloaded or installed here: the harness uses only the
# Python standard library, so the build on the Pi is a copy, not a fetch.
COPY app /opt/harness
COPY rootfs /

RUN chmod a+x /etc/services.d/harness/run /etc/services.d/harness/finish \
    && python3 -c "import sys; sys.path.insert(0, '/opt/harness'); import harness.controller, harness.setup_web"

LABEL \
    io.hass.type="addon" \
    io.hass.version="0.3.0" \
    org.opencontainers.image.title="Harness" \
    org.opencontainers.image.description="Deterministic controller for a private Telegram thread"
