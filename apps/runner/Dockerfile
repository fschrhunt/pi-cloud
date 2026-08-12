# This image is a local-development runner baseline, not a production security boundary.
FROM node:22-bookworm-slim AS build
WORKDIR /opt/pi-cloud
COPY package.json package-lock.json tsconfig.base.json ./
COPY contracts/package.json contracts/tsconfig.json ./contracts/
COPY apps/runner/package.json apps/runner/tsconfig.json ./apps/runner/
RUN npm ci --workspace=@pi-cloud/runner --include-workspace-root
COPY contracts/src ./contracts/src
COPY apps/runner/src ./apps/runner/src
RUN npm run build --workspace=@pi-cloud/contracts && npm run build --workspace=@pi-cloud/runner

FROM node:22-bookworm-slim
WORKDIR /opt/pi-cloud
RUN groupadd --system --gid 10001 pi && useradd --system --uid 10001 --gid pi --create-home pi
COPY --from=build /opt/pi-cloud/node_modules ./node_modules
COPY --from=build /opt/pi-cloud/contracts/package.json ./contracts/package.json
COPY --from=build /opt/pi-cloud/contracts/dist ./contracts/dist
COPY --from=build /opt/pi-cloud/apps/runner/package.json ./apps/runner/package.json
COPY --from=build /opt/pi-cloud/apps/runner/dist ./apps/runner/dist
USER pi
ENTRYPOINT ["node", "apps/runner/dist/runner.js"]
