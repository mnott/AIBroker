# Real-Linux proof: the daemon on a host with tmux and no iTerm, no launchd.
# Build context is the repo root:  docker build -f test/linux/Dockerfile .
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux procps ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /home/node/aibroker
COPY --chown=node:node . .
RUN npm ci && npm run build

CMD ["bash", "test/linux/smoke.sh"]
