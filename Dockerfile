# Multi-stage build for the MCP server. Build stage compiles TypeScript to
# dist/; runtime stage ships only production deps and compiled JS.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# Shipped defaults; env vars override at runtime.
COPY config.example.json ./config.example.json
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
