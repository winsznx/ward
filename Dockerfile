# Ward provider — the long-running worker that holds one WebSocket open so Ward shows
# "online" on the CROO Store and fulfils Token DD Verdict orders (H2A). Node 20 for global fetch
# (the Groq firewall judge). Only the two dirs the provider needs are copied; env comes from Railway.
FROM node:20-slim
WORKDIR /app

# firewall/src is imported by the orchestrator via a relative path (../../firewall/src/*) and is pure
# TS with no npm deps, so it needs no install of its own — just the source on disk.
COPY firewall ./firewall
COPY orchestrator ./orchestrator

WORKDIR /app/orchestrator
RUN npm install --omit=dev --no-audit --no-fund

CMD ["npm", "run", "provider"]
