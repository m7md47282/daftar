# daftar API — Node 24 runs the TypeScript sources directly (type stripping), no build step.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-kacst fonts-hosny-amiri ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium NODE_ENV=production
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/
COPY web/package.json web/
COPY mcp/package.json mcp/
RUN pnpm install --filter server --prod --frozen-lockfile
COPY server/src server/src
COPY server/scripts server/scripts
COPY db db
USER node
EXPOSE 8080
CMD ["node", "server/src/main.ts"]
