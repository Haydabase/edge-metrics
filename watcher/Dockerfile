# Built with the repo root as build context so it can COPY the shared
# categorize/ module - see `just watcher-build`.
FROM node:22-alpine

ARG TARGETARCH
ARG KUBECTL_VERSION=v1.31.0

# kubectl is still used for the apply side (get/patch configmap, patch
# deployment) - see watcher/src/reconcile.ts. The generate side no longer
# shells out to anything, so no bash/jq needed here anymore.
RUN apk add --no-cache curl \
  && curl -fsSL -o /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
  && chmod +x /usr/local/bin/kubectl

WORKDIR /app
COPY categorize/src ./categorize/src
WORKDIR /app/watcher
COPY watcher/package.json watcher/package-lock.json ./
RUN npm ci --omit=dev
COPY watcher/src ./src

ENTRYPOINT ["node_modules/.bin/tsx", "src/index.ts"]
