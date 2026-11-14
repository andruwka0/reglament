# syntax=docker/dockerfile:1
FROM node:24.22.3-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

COPY angular.json tsconfig.json tsconfig.app.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:24.22.3-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/var/lib/reglament \
    SECURE_COOKIE=1

RUN install -d -m 0700 -o node -g node /var/lib/reglament
COPY --from=build --link /app/dist/regatta-tracker/browser ./dist/regatta-tracker/browser
COPY --link server/index.mjs server/telegram.mjs server/telegram-link.mjs server/workflow.mjs server/demo.json ./server/

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server/index.mjs"]
