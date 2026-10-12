FROM node:22-alpine AS builder

COPY . /app
COPY tsconfig.json /tsconfig.json

WORKDIR /app

RUN npm install -g pnpm@11.10.0

RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --ignore-scripts

RUN pnpm run build

FROM node:22-alpine AS release

WORKDIR /app

RUN npm install -g pnpm@11.10.0

COPY --from=builder /app/build /app/build
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-lock.yaml

ENV NODE_ENV=production

RUN pnpm install --prod --frozen-lockfile --ignore-scripts

USER node

ENTRYPOINT ["node", "build/index.js"]
