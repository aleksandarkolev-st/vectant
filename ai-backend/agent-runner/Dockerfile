FROM node:22-alpine@sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c

ARG CODEX_VERSION=0.149.0
ARG CLAUDE_CODE_VERSION=2.1.240
ARG HERMES_AGENT_VERSION=0.19.0

RUN apk add --no-cache python3 py3-pip git ca-certificates \
 && npm install --global --omit=dev "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && python3 -m venv /opt/hermes \
 && /opt/hermes/bin/pip install --no-cache-dir "hermes-agent==${HERMES_AGENT_VERSION}" \
 && addgroup -S -g 10001 agent \
 && adduser -S -D -H -u 10001 -G agent agent

COPY --chmod=0555 entrypoint.sh /usr/local/bin/agent-entrypoint
USER 10001:10001
ENV PATH="/opt/hermes/bin:${PATH}"
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/agent-entrypoint"]
