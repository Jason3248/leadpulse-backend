# Multi-stage build keeps the runtime image small and free of build tooling.
FROM node:20-alpine AS deps
WORKDIR /app

# The workspace root manifest plus every package manifest, so npm can
# resolve the workspace links before any source is copied. Doing this
# before copying source means dependency layers stay cached across code
# changes.
COPY package.json package-lock.json ./
COPY leadpulse-data-model/package.json ./leadpulse-data-model/
COPY leadpulse-api/package.json ./leadpulse-api/
COPY leadpulse-upload-service/package.json ./leadpulse-upload-service/
COPY leadpulse-email-service/package.json ./leadpulse-email-service/
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY leadpulse-data-model ./leadpulse-data-model
COPY leadpulse-api ./leadpulse-api

# Run as the built-in non-root user rather than root.
USER node

WORKDIR /app/leadpulse-api
CMD ["node", "app/server.js"]
