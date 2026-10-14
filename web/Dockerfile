FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/
COPY web/package.json web/
COPY mcp/package.json mcp/
RUN pnpm install --filter web --frozen-lockfile
COPY web/ web/
RUN cd web && pnpm ng build --configuration production

# nginx serves the app and proxies /api and /s (share links) to the API, so cookies stay same-origin.
FROM nginx:1.27-alpine
COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/web/dist/web/browser /usr/share/nginx/html
ENV PORT=8080 API_URL=http://api:8080
EXPOSE 8080
