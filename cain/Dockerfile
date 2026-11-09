# Debian, not Alpine: Claude Code's native build and Bun both want glibc.
# Home Assistant's base carries s6-overlay (hence init: false) and bashio.
ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:trixie-2026.10.3
FROM ${BUILD_FROM}
ARG BUILD_ARCH

# Pinned versions. Claude Code's own updater is off (DISABLE_AUTOUPDATER):
# a new version arrives as a new add-on version, which he approves.
ARG CLAUDE_VERSION=2.1.317
ARG BUN_VERSION=1.4.4
# ttyd isn't packaged for Debian trixie: the official static release, checked by hash.
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA_AARCH64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165
ARG TTYD_SHA_X86_64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git unzip tmux nginx ripgrep jq tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && case "${BUILD_ARCH}" in \
         aarch64) TT=aarch64; TS="${TTYD_SHA_AARCH64}" ;; \
         amd64)   TT=x86_64;  TS="${TTYD_SHA_X86_64}" ;; \
         *) echo "unsupported arch ${BUILD_ARCH}"; exit 1 ;; \
       esac \
    && curl -fsSL -o /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${TT}" \
    && echo "${TS}  /usr/local/bin/ttyd" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/ttyd \
    && curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}" \
    && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && install -m 0755 "$(readlink -f /root/.local/bin/claude)" /usr/local/bin/claude \
    && install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun \
    && rm -rf /root/.local /root/.bun /root/.cache /root/.claude \
    && claude --version && bun --version && ttyd --version

ENV DISABLE_AUTOUPDATER=1

COPY rootfs /
RUN chmod a+x /etc/services.d/*/run /etc/services.d/*/finish /opt/cain/*.sh

LABEL \
    io.hass.type="addon" \
    io.hass.version="0.3.2" \
    org.opencontainers.image.title="Cain" \
    org.opencontainers.image.description="Claude Code answering a private Discord bot"
