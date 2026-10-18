# Zoe AI responder — runs the responder loop (scripts/responder/loop.md) HEADLESS on Fly, authenticated with
# a Claude SUBSCRIPTION OAuth token (CLAUDE_CODE_OAUTH_TOKEN), NOT an API key. So it is subscription-priced,
# survives reboots, and needs no office machine.
#
# ⚠️ NEVER set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) on this app. In headless `-p` mode those OUTRANK
#    the OAuth token and would silently switch billing to the metered API. run-loop.mjs refuses to start if
#    one is present, as a backstop.
#
# Build context is the REPO ROOT (fly.toml sets dockerfile = deploy/responder/Dockerfile): the loop needs
# scripts/responder/* + docs/, and improvement-run PRs need the full tree + git.

FROM node:22-bookworm-slim

# git + https for improvement-run PRs and the Confluence/bridge calls; curl for the loop's bridge POSTs.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system user.email "responder@zoe-ops.local" \
  && git config --system user.name "Zoe AI Responder"

# The Claude Code CLI. PINNED deliberately — the headless flags (--permission-mode, --allowedTools, the
# --bare default) are version-sensitive; see deploy/responder/README.md. A floating `latest` can silently
# change headless auth/flag behavior under us. Bump this after verifying the flags against the changelog.
ARG CLAUDE_CODE_VERSION=2.1.302
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

WORKDIR /app
COPY . .

# Claude Code keeps its state (auth cache, transcripts) under $HOME/.claude. Point HOME at the mounted volume
# (/data, see fly.toml) so `--continue` and the session store survive restarts.
ENV HOME=/data
ENV NODE_ENV=production

CMD ["node", "deploy/responder/run-loop.mjs"]
