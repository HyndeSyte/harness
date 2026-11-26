# The keeper of installs: Bun on Home Assistant's Debian base (s6-overlay, hence init: false).
ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:trixie-2026.10.3
FROM ${BUILD_FROM}
ARG BUILD_ARCH

# Same Bun as Cain's image (cain/Dockerfile BUN_VERSION).
ARG BUN_VERSION=1.4.4

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun \
    && rm -rf /root/.bun /root/.cache \
    && bun --version

# The keeper's version, bound into its armed record: the same as config.yaml's (keeper/tests check it).
ENV KEEPER_VERSION=0.1.18

COPY rootfs /
RUN chmod a+x /etc/services.d/keeper/run /etc/services.d/keeper/finish \
    && bun /opt/keeper/main.ts selftest

LABEL \
    io.hass.type="addon" \
    io.hass.version="0.1.18" \
    org.opencontainers.image.title="Keeper" \
    org.opencontainers.image.description="A check after every App install, with automatic rollback"
