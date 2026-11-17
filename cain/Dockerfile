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
# Codex CLI (the OpenAI review seat): the official static musl release, checked by
# hash. A new version arrives as a new add-on version. bubblewrap is its Linux sandbox.
ARG CODEX_VERSION=0.167.0
ARG CODEX_SHA_AARCH64=843489acb4d4b1079745c36b03c5963b887b83155af208fd53584e33ee8eb281
ARG CODEX_SHA_X86_64=9d64836106d5b374e90ee4454c7ebcde7ca7106558bd7e41a34b9f26ebda251a

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git openssh-client unzip tmux nginx ripgrep jq tzdata bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && case "${BUILD_ARCH}" in \
         aarch64) TT=aarch64; TS="${TTYD_SHA_AARCH64}"; CS="${CODEX_SHA_AARCH64}" ;; \
         amd64)   TT=x86_64;  TS="${TTYD_SHA_X86_64}"; CS="${CODEX_SHA_X86_64}" ;; \
         *) echo "unsupported arch ${BUILD_ARCH}"; exit 1 ;; \
       esac \
    && curl -fsSL -o /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${TT}" \
    && echo "${TS}  /usr/local/bin/ttyd" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/ttyd \
    && curl -fsSL -o /tmp/codex.tgz "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-${TT}-unknown-linux-musl.tar.gz" \
    && echo "${CS}  /tmp/codex.tgz" | sha256sum -c - \
    && mkdir /tmp/codex && tar -xzf /tmp/codex.tgz -C /tmp/codex \
    && install -m 0755 "$(find /tmp/codex -type f -name 'codex*' | head -n 1)" /usr/local/bin/codex \
    && rm -rf /tmp/codex /tmp/codex.tgz \
    && curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}" \
    && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && install -m 0755 "$(readlink -f /root/.local/bin/claude)" /usr/local/bin/claude \
    && install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun \
    && rm -rf /root/.local /root/.bun /root/.cache /root/.claude \
    && claude --version && bun --version && ttyd --version && codex --version

ENV DISABLE_AUTOUPDATER=1

# C1: Cain's session runs as its own user, and the Discord plugin's server as another, so
# neither reaches a key root keeps. Fixed ids: /data keeps numeric owners across versions.
RUN groupadd -g 1000 cain && useradd -u 1000 -g cain -d /data/cain -M -s /bin/bash cain \
    && groupadd -g 1001 discord && useradd -u 1001 -g discord -d /data/discord -M -s /usr/sbin/nologin discord

COPY rootfs /
RUN chmod a+x /etc/services.d/*/run /etc/services.d/*/finish /opt/cain/*.sh /opt/cain/c1/*.sh /opt/cain/as-cain

# The Discord plugin, pinned in the image (/opt/cain/discord/pin.json), fetched only here:
#   - the seed Claude Code loads it from (CLAUDE_CODE_PLUGIN_SEED_DIR, read only, never
#     updated), whose .mcp.json runs the bridge to the broker instead of the server;
#   - the server itself with its packages, which the broker runs as discord.
# The build fails unless every pinned file matches its hash.
RUN set -eu; seed=/opt/cain/plugin-seed; pin=/opt/cain/discord/pin.json; \
    commit="$(jq -r .commit "$pin")"; \
    CLAUDE_CODE_PLUGIN_CACHE_DIR="$seed" claude plugin marketplace add anthropics/claude-plugins-official; \
    git -C "$seed/marketplaces/claude-plugins-official" fetch -q --depth 1 origin "$commit"; \
    git -C "$seed/marketplaces/claude-plugins-official" -c advice.detachedHead=false checkout -q --detach "$commit"; \
    CLAUDE_CODE_PLUGIN_CACHE_DIR="$seed" claude plugin install discord@claude-plugins-official --scope user; \
    plugin="$(dirname "$(find "$seed/cache" -path '*/discord/*/.claude-plugin/plugin.json' | head -n 1)")/.."; \
    plugin="$(readlink -f "$plugin")"; \
    for f in $(jq -r '.files | keys[]' "$pin"); do \
      echo "$(jq -r --arg f "$f" '.files[$f]' "$pin")  $plugin/$f" | sha256sum -c - ; \
    done; \
    install -d -m 0755 /opt/cain/discord/plugin; \
    cp -a "$plugin/." /opt/cain/discord/plugin/; \
    (cd /opt/cain/discord/plugin && bun install --frozen-lockfile --production --no-summary); \
    install -m 0644 /opt/cain/discord/seed-mcp.json "$plugin/.mcp.json"; \
    rm -rf /root/.claude /root/.claude.json /root/.cache /root/.bun; \
    mkt="$seed/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json"; \
    jq '.plugins |= map(select(.name == "discord"))' "$mkt" > "$mkt.tmp" && mv "$mkt.tmp" "$mkt"; \
    test "$(jq -r '[.plugins[].name] | join(",")' "$mkt")" = discord; \
    chown -R root:root "$seed" /opt/cain/discord/plugin; chmod -R a+rX,go-w "$seed" /opt/cain/discord/plugin
# The seed's copy of the official marketplace lists the Discord plugin alone (C1 code review C1-3):
# the seed's entry overrides his own at every start and isn't refreshed, so no other plugin of it
# can be installed into his session; the managed MCP allowlist (settings.json) takes the rest.

# Cain's rules (/opt/cain/settings.json and CLAUDE.md) go to /etc/claude-code, where Claude
# Code reads managed policy, at every start that runs him as his own user, checked by hash
# (c1/lock.sh): a container Home Assistant recreates keeps only /data, and the old way of
# starting, before the first cutover, must run without them.

# No setuid or setgid program can raise him (his session also runs with no_new_privs).
RUN find / -xdev -type f -perm /6000 -exec chmod ug-s {} + \
    && test -z "$(find / -xdev -type f -perm /6000 -print -quit)"

LABEL \
    io.hass.type="addon" \
    io.hass.version="0.12.1" \
    org.opencontainers.image.title="Cain" \
    org.opencontainers.image.description="Claude Code answering a private Discord bot"
