# Built with the repo root as build context so it can COPY
# scripts/generate-categorize-rules.sh - see `just watcher-build`.
FROM node:22-alpine

ARG TARGETARCH
ARG KUBECTL_VERSION=v1.31.0

RUN apk add --no-cache bash jq curl \
  && curl -fsSL -o /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
  && chmod +x /usr/local/bin/kubectl

COPY scripts/generate-categorize-rules.sh /usr/local/bin/generate-categorize-rules.sh
RUN chmod +x /usr/local/bin/generate-categorize-rules.sh

WORKDIR /app
COPY watcher/package.json watcher/package-lock.json ./
RUN npm ci --omit=dev
COPY watcher/index.js watcher/reconcile.js ./

ENTRYPOINT ["node", "index.js"]
