FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production APP_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json VERSION* ./
COPY db ./db
COPY public ./public
COPY scripts/docker-entrypoint.sh /usr/local/bin/tijara-entrypoint
# The entrypoint gives the media volume to "node", then drops root for good (setpriv, no new privileges).
ENTRYPOINT ["/usr/local/bin/tijara-entrypoint"]
EXPOSE 3000
# The runtime image NEVER runs migrations and never holds admin credentials.
# Migrations are a separate privileged service (railway.migrate.json -> node dist/migrate.js).
CMD ["node", "dist/server.js"]
