FROM node:22-bookworm-slim@sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066

ARG CODEX_VERSION=0.149.0
ARG CLAUDE_CODE_VERSION=2.1.240
ARG HERMES_AGENT_VERSION=0.19.0

RUN apt-get update \
 && apt-get install --yes --no-install-recommends python3 python3-venv git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --omit=dev "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && python3 -m venv /opt/hermes \
 && /opt/hermes/bin/pip install --no-cache-dir "hermes-agent==${HERMES_AGENT_VERSION}" \
 && groupadd --system --gid 10001 agent \
 && useradd --system --no-create-home --uid 10001 --gid 10001 agent

COPY --chmod=0555 entrypoint.sh /usr/local/bin/agent-entrypoint
USER 10001:10001
ENV PATH="/opt/hermes/bin:${PATH}"
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/agent-entrypoint"]
