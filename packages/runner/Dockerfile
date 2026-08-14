# This image provides the local-development and single-operator hosted runner baseline.
FROM node:22-bookworm-slim AS build
WORKDIR /opt/pi-cloud
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/runner/package.json packages/runner/tsconfig.json ./packages/runner/
RUN npm ci --workspace=@pi-cloud/runner --include-workspace-root
COPY packages/contracts/src ./packages/contracts/src
COPY packages/runner/src ./packages/runner/src
RUN npm run build --workspace=@pi-cloud/contracts && npm run build --workspace=@pi-cloud/runner

FROM node:22-bookworm-slim
WORKDIR /opt/pi-cloud
ENV PATH="/opt/pi-cloud/node_modules/.bin:${PATH}" \
    HOME=/tmp/pi-cloud-runner-home
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 pi \
 && useradd --system --uid 10001 --gid pi --create-home --home-dir /home/pi pi
COPY --from=build /opt/pi-cloud/node_modules ./node_modules
COPY --from=build /opt/pi-cloud/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /opt/pi-cloud/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /opt/pi-cloud/packages/runner/package.json ./packages/runner/package.json
COPY --from=build /opt/pi-cloud/packages/runner/dist ./packages/runner/dist
RUN mkdir -p /var/lib/pi-cloud/workspaces /var/lib/pi-cloud/agent /tmp/pi-cloud-runner-home \
 && chmod 0711 /var/lib/pi-cloud/workspaces \
 && chmod 0555 /var/lib/pi-cloud/agent \
 && chmod 0700 /tmp/pi-cloud-runner-home \
 && chmod 1777 /tmp
USER root
ENTRYPOINT ["/bin/sh", "-c", "if [ -z \"${PI_CLOUD_HOSTED_DISPATCHER_TOKEN:-}\" ]; then exec node packages/runner/dist/runner.js; fi; trap 'kill -TERM \"$child\" 2>/dev/null; wait \"$child\"; exit 0' TERM INT; while :; do node packages/runner/dist/runner.js & child=$!; wait \"$child\"; status=$?; if [ \"$status\" -ne 0 ]; then exit \"$status\"; fi; sleep 1; done"]
