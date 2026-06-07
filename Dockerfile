# --- App image: runs the HTTP server (GUI + REST + MCP) -------------------
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first (better layer caching). We keep devDependencies
# because the server runs via tsx (TypeScript executed directly).
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

# Application sources
COPY tsconfig.json ./
COPY src ./src
COPY server ./server
COPY web ./web

EXPOSE 8080

# Basic container healthcheck against the public /healthz endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "server/http.ts"]
