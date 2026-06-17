# Orbital — production image for Coolify (or any Docker host).
# Node 22+ is required: @supabase/supabase-js needs a native WebSocket,
# which Node ships globally from v22 onward.
FROM node:22-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source.
COPY . .

ENV NODE_ENV=production
ENV PORT=4173
EXPOSE 4173

# Lightweight healthcheck Coolify can use.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4173/api/health || exit 1

CMD ["node", "server/index.js"]
