# syntax=docker/dockerfile:1
# Docker Hardened Image (dhi.io/node:24-alpine).
# Near-zero CVEs (Scout: 0C/0H/0M, 11 packages, health A) vs node:24-alpine
# (0C/5H). Requires `docker login dhi.io` once per machine (public entitlement,
# Docker ID is enough) — pulls work anonymously after the image is cached.
#
# DHI runtime has NO shell / package manager / coreutils (only node+npm) and
# already runs as non-root `node` (uid 1000) with WORKDIR /app. So:
# - all shell (RUN apk/addgroup) lives in the -dev builder stages only,
# - the runner stage has zero RUN instructions,
# - HEALTHCHECK is exec-form `node -e` (no wget/curl in the image).

# Install production dependencies only (dev variant has shell + npm)
FROM dhi.io/node:24-alpine-dev AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Build the application (dev variant has shell + npm)
FROM dhi.io/node:24-alpine-dev AS builder
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# Production image — DHI runtime, non-root `node`, no shell
FROM dhi.io/node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json

USER node
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:5000/api/network/stats').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
