# Game server image. Build context is the repo root, since npm workspaces
# needs every workspace's package.json for `npm ci` to trust the lockfile:
#
#   docker build -t embuscade-server:local .
#
# Only packages/server and packages/shared run in it -- the client is
# built separately (packages/client's `npm run build`) and served by
# whatever page embeds it.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/client/package.json packages/client/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @bolo/server --include-workspace-root

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node AI-taunts.json ./AI-taunts.json
COPY --chown=node:node packages/shared packages/shared
COPY --chown=node:node packages/server/package.json packages/server/package.json
COPY --chown=node:node packages/server/src packages/server/src
USER node
EXPOSE 8082
CMD ["node", "packages/server/src/server.js"]
