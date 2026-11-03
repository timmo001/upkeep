# The Upkeep server as a Home Assistant app. Serves plain HTTP on port 7272,
# and the dashboard to Home Assistant ingress on 8099, with its database in
# /data. It runs as root because the Supervisor creates /data, and writes
# /data/options.json with mode 0600, as root.

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build

WORKDIR /src

COPY package.json bun.lock ./
COPY packages/api/package.json packages/api/
COPY packages/cli/package.json packages/cli/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/opencode/package.json packages/opencode/
COPY packages/server/package.json packages/server/
COPY packages/worker/package.json packages/worker/
COPY docs/package.json docs/

RUN bun install --frozen-lockfile --filter @upkeep/cli --ignore-scripts

COPY packages packages

WORKDIR /src/packages/cli

ARG UPKEEP_BUILD_VERSION=dev

RUN bun run build

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f

COPY --from=build /src/packages/cli/dist/upkeep /usr/local/bin/upkeep

ENV UPKEEP_HOSTNAME=:: \
    UPKEEP_PORT=7272 \
    UPKEEP_INGRESS_PORT=8099 \
    UPKEEP_SERVER_DB=/data/server.db \
    UPKEEP_OPTIONS=/data/options.json

USER root

EXPOSE 7272

ENTRYPOINT ["/usr/local/bin/upkeep"]

CMD ["serve"]
