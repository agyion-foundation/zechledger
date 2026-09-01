FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runner
WORKDIR /app
LABEL org.opencontainers.image.title="ZechLedger" \
      org.opencontainers.image.description="Privacy-preserving Zcash testnet accounting and audit prototype" \
      org.opencontainers.image.source="https://github.com/apo110-dev/zechledger" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    ZECHLEDGER_DATA_DIR=/data
RUN groupadd --system --gid 1001 zechledger && useradd --system --uid 1001 --gid zechledger zechledger \
    && mkdir -p /data && chown -R zechledger:zechledger /data
COPY --from=builder --chown=zechledger:zechledger /app/.next/standalone ./
COPY --from=builder --chown=zechledger:zechledger /app/.next/static ./.next/static
COPY --from=builder --chown=zechledger:zechledger /app/public ./public
USER zechledger
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
