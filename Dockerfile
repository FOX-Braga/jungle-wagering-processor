FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig*.json mikro-orm.config.ts ./
COPY src ./src
COPY scripts ./scripts
RUN bun run build

FROM oven/bun:1.4.4 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=bun:bun --from=build /app/dist ./dist
USER bun
EXPOSE 3000
CMD ["bun", "--no-env-file", "dist/src/main.js"]
