# edge-metrics

An OpenTelemetry Collector configuration for enriching edge logs in realtime, producing Prometheus metrics, and exporting the enriched logs to Grafana Loki — plus a one-command local Kubernetes demo (kind + Envoy Gateway + Prometheus + Grafana + Loki).

This is a sanitized, standalone version of a real internal observability pipeline, adapted for a conference talk. The fake company, domains, and product taxonomy below are fictional; the OTel Collector patterns (OTTL enrichment, connector-chained pipelines, log-to-metric derivation) are real and battle-tested.

## Overview

This project provides an **OpenTelemetry Collector** configuration that processes logs from Cloudflare and Envoy Gateway. The collector enriches the log records with standardised fields, categorizes requests by product/service, classifies errors by SLI type, and generates Prometheus metrics for realtime monitoring and alerting. It also exports the enriched edge logs to Grafana Loki for log-based querying.

### Ingress to the demo platform

For regular TLS traffic, TLS is terminated at the edge in Cloudflare, so here we have HTTP request logs from Cloudflare.

For mTLS traffic, TLS is terminated in Envoy Gateway, so this is the first part of the system where we get HTTP request level logging.

```
       ┌─────────────────────┐
       │       Clients       │
       └─────────────────────┘
         │                 │
    TLS Traffic      mTLS Traffic
         │                 │
         V                 │
  ┌────────────┐           │
  │ Cloudflare │           │
  └────────────┘           │
         │                 │
┌────────│─────────────────│────────┐
│ K8s    V                 V        │
│ ┌───────────────────────────────┐ │
│ │         Envoy Gateway         │ │
│ └───────────────────────────────┘ │
│     │           │           │     │
│     V           V           V     │
│ ┌───────┐   ┌───────┐   ┌───────┐ │
│ │  App  │   │  App  │   │  App  │ │
│ └───────┘   └───────┘   └───────┘ │
└───────────────────────────────────┘
```

Note that Envoy Gateway produces HTTP request logs for both regular TLS and mTLS traffic (in this demo, both hostnames route to the same handful of demo apps — see [k8s/demo-app/](./k8s/demo-app/)).

In order to report and monitor HTTP requests as close to the edge as possible, we treat different logs as the "edge" logs for mTLS vs regular TLS:
- non-mTLS traffic: Cloudflare logs
- mTLS traffic: Envoy Gateway logs

In this local demo, there's no real Cloudflare in front of the cluster, so the [demo UI](#demo-ui) simulates Cloudflare's Logpush push for every non-mTLS request it sends — see below.

## Log fields

A set of common fields are extracted / derived from the existing fields on both Cloudflare and Envoy Gateway logs.

See [LOGS.md](./LOGS.md) for a comprehensive list.

## Metrics

A number of Prometheus metrics are derived from the logs.

See [METRICS.md](./METRICS.md) for a comprehensive list.

## Collector Configuration

Configuration can be found here: [otel-collector-config.yaml](otel-collector-config.yaml)

The collector configuration takes advantage of [connectors](https://opentelemetry.io/docs/collector/components/connector/) to chain together multiple pipelines:

```
              Cloudflare Logs                          Envoy Gateway Logs
                     │                                         │
┌────────────────────│─────────────────────────────────────────│─────────────────────┐
│                    │              OTel Collector             │                     │
│                    V                                         V                     │
│ ┌────────────[cloudflare]─────────────┐   ┌─────────────[otlp/envoy]────────────┐  │
│ │                                     │   │                                     │  │
│ │      [logs/cloudflare] Pipeline     │   │        [logs/envoy] Pipeline        │  │
│ │  ─────────────────────────────────  │   │  ─────────────────────────────────  │  │
│ │  Extracts common fields + filters   │   │  Extracts common fields             │  │
│ │  to only 'eyeball' source logs      │   │                                     │  │
│ │                                     │   │                                     │  │
│ │  Processors:                        │   │  Processors:                        │  │
│ │  - [filter/cloudflare]              │   │  - [attributes/envoy]               │  │
│ │  - [attributes/cloudflare]          │   │  - [transform/envoy]                │  │
│ │  - [transform/cloudflare]           │   │                                     │  │
│ │                                     │   │                                     │  │
│ └──────[forward/combine_ingress]──────┘   └──────[forward/combine_ingress]──────┘  │
│                    │                                         │                     │
│                    └─────────────────────────────────────────┘                     │
│                                         │                                          │
│                                         V                                          │
│                      ┌──────[forward/combine_ingress]──────┐                       │
│                      │                                     │                       │
│                      │        logs/ingress Pipeline        │                       │
│                      │  ─────────────────────────────────  │                       │
│                      │  Derives and calculates more        │                       │
│                      │  common fields from those already   │                       │
│                      │  extracted                          │                       │
│                      │                                     │                       │
│                      │  Processors:                        │                       │
│                      │  - [transform/ingress]              │                       │
│                      │  - [transform/categorize]           │                       │
│                      │                                     │                       │
│                      └───────────[forward/edge]────────────┘                       │
│                                         │                                          │
│                                         V                                          │
│  ┌───────────────────────────────[forward/edge]─────────────────────────────────┐  │
│  │                                                                              │  │
│  │                             logs/edge Pipeline                               │  │
│  │                      ─────────────────────────────────                       │  │
│  │                      Filters out non-mTLS Envoy logs                         │  │
│  │                      to leave a single edge log record                       │  │
│  │                      per HTTP request                                        │  │
│  │                                                                              │  │
│  │                      Processors:                                             │  │
│  │                      - [filter/edge]                                         │  │
│  │                                                                              │  │
│  └─[count/edge]─[signaltometrics/edge]──────────────[forward/edge_export]───────┘  │
│          │                │                                   │                    │
│          V                V                                   V                    │
│  ┌─[count/edge]─[signaltometrics/edge]─┐   ┌────────[forward/edge_export]───────┐  │
│  │                                     │   │                                    │  │
│  │        metrics/edge Pipeline        │   │      logs/edge_export Pipeline     │  │
│  │  ─────────────────────────────────  │   │  ───────────────────────────────── │  │
│  │  Renames metric labels from log     │   │  Ships enriched edge logs to       │  │
│  │  standards to conform to other      │   │  Grafana Loki for log-based        │  │
│  │  existing standard metric naming,   │   │  querying.                         │  │
│  │  and exposes metrics to Prometheus  │   │                                    │  │
│  │                                     │   │                                    │  │
│  │  Processors:                        │   │  Processors: (none)                │  │
│  │  - [attributes/edge_metrics]        │   │                                    │  │
│  │  - [transform/edge_metrics]         │   │                                    │  │
│  │                                     │   │                                    │  │
│  └────────────[prometheus]─────────────┘   └──────────[otlphttp/edge]───────────┘  │
│                     Λ                                         │                    │
│                     │                                         │                    │
└─────────────────────│─────────────────────────────────────────│────────────────────┘
                      │                                         V
             Prometheus Scraping                          Grafana Loki
```

A mermaid version of this diagram is in [docs/architecture.md](./docs/architecture.md).

The logs are processed in stages:

1. [Ingestion Pipelines](#stage-1-ingestion-pipelines)
2. [Combined Ingress Logs Pipeline](#stage-2-combined-ingress-logs-pipeline)
3. [Edge Logs Pipeline](#stage-3-edge-logs-pipeline)
4. [Logs to Metrics Connectors](#stage-4-logs-to-metrics-connectors)
5. [Edge Metrics Pipeline](#stage-5-edge-metrics-pipeline)
6. [Edge Log Export Pipeline](#stage-6-edge-log-export-pipeline)

### [Stage 1] Ingestion Pipelines
> `cloudflare` + `otlp/envoy`

There is a pipeline per ingress log layer (Cloudflare + Envoy Gateway), which extracts some standard named and formatted fields, which are either useful themselves or are used in later stages to derive/calculate other fields.

Receivers for each ingress layer are configured:
- **Cloudflare**: [Cloudflare Receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/receiver/cloudflarereceiver)
- **Envoy Gateway**: [OTLP Receiver](https://github.com/open-telemetry/opentelemetry-collector/tree/main/receiver/otlpreceiver) (OTLP gRPC is supported as an Envoy Access Log [sink](https://gateway.envoyproxy.io/docs/tasks/observability/proxy-accesslog/#opentelemetry-sink))

The output of these pipelines is logs that can go through the same enrichment pipeline (without consideration of the ingress layer).

Both these pipelines are therefore connected to the pipeline via a [forward connector](https://github.com/open-telemetry/opentelemetry-collector/tree/main/connector/forwardconnector).

### [Stage 2] Combined Ingress Logs Pipeline
> `logs/ingress`

This pipeline further enriches the logs, for example extracting fields returned by application headers, client IDs, calculating latencies etc., and categorising the product and application to which requests are routed.

The output of this pipeline is a single stream of logs from both ingress layers containing all standard fields.

This pipeline is connected to the next pipeline via a [forward connector](https://github.com/open-telemetry/opentelemetry-collector/tree/main/connector/forwardconnector).

### [Stage 3] Edge Logs Pipeline
> `logs/edge`

This pipeline filters the logs to ensure a single log per HTTP request, as close to the edge as possible:
- Include Cloudflare logs for non-mTLS requests
- Include only logs from Envoy Gateway that are for mTLS requests

The output of this pipeline is a single stream of logs with a single log per HTTP request across both mTLS and non-mTLS ingresses.

**This should be used as the source for any edge SLI calculations (e.g. availability, latency).**

This pipeline is connected to the metrics pipeline via some specialized metrics connectors:

### [Stage 4] Logs to Metrics Connectors
> `count/edge` + `signaltometrics/edge`

Two separate connectors are used for transforming the edge logs into metrics:
1. [Count Connector](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/countconnector)
   - Creates counters
2. [Signal to Metrics Connector](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/signaltometricsconnector)
   - Creates histograms
   - _Note this connector can create counters, but they are not created as [monotonic](https://opentelemetry.io/docs/specs/otel/metrics/data-model/#sums) and so are excluded by the [Prometheus exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/16efa9decb99fd3ca291d9e567e261ade09acd68/exporter/prometheusexporter/accumulator.go#L177), therefore we use the separate `count` connector for counters._

Both enable using log fields as labels for metrics, allowing us to create series based on product, application, domain etc.

### [Stage 5] Edge Metrics Pipeline
> `metrics/edge`

The metrics pipeline renames the log fields used in the metrics to better match conventions used in typical application-level REST API metrics, and uses the [Prometheus exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/prometheusexporter) to expose a Prometheus scraping endpoint.

This pipeline also has to work around the fact that the [metric connectors](#stage-4-logs-to-metrics-connectors) produce delta metrics with timestamps which do not play nice with the Prometheus exporter:
- [Count Connector](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/countconnector) produces [delta sums](https://opentelemetry.io/docs/specs/otel/metrics/data-model/#sums) with [both start and end timestamps](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/ec04c7a8bf08e8fa8ff2f19d26c8689863f3e713/connector/countconnector/counter.go#L85) of the delta set to the [timestamp of the log record](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/325a2e10af7acd63234cd9a7358f9dfff3445f3a/connector/countconnector/connector.go#L207), so data points can come through with out of order timestamps, which get [dropped](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/6719e7af8de36f2b5e07ce602eb13996d2933017/exporter/prometheusexporter/accumulator.go#L208-L211) by the Prometheus exporter. (Note that even if the deltas all arrive in order, they would not be contiguous, which they must be for the exporter to [accumulate them correctly](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/6719e7af8de36f2b5e07ce602eb13996d2933017/exporter/prometheusexporter/accumulator.go#L214-L222).)
- [Signal to Metrics Connector](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/signaltometricsconnector) produces [delta histograms](https://opentelemetry.io/docs/specs/otel/metrics/data-model/#histogram) and [does not set the start timestamp](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/6719e7af8de36f2b5e07ce602eb13996d2933017/connector/signaltometricsconnector/internal/aggregator/explicithistogram.go#L59) of the delta, so data points get [dropped](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/6719e7af8de36f2b5e07ce602eb13996d2933017/exporter/prometheusexporter/accumulator.go#L266-L278) by the Prometheus exporter. There is an open issue to address this: https://github.com/open-telemetry/opentelemetry-collector-contrib/issues/38602.

The "fix" was to override both the start and end timestamps of metric data points to be a static timestamp (chosen to be simply the Unix epoch) using the `transform/edge_metrics` processor. This means the Prometheus exporter sees the start timestamp of incoming deltas as always matching the end timestamp of the last received delta, never before or after, and so nothing is dropped or reset.

### [Stage 6] Edge Log Export Pipeline
> `logs/edge_export`

A parallel pipeline branches off the edge logs (via a `forward/edge_export` connector attached to the [Edge Logs Pipeline](#stage-3-edge-logs-pipeline)) to ship the enriched logs to Grafana Loki, for log-based querying alongside the Prometheus metrics. Loki 3.x+ has native OTLP log ingestion, so this uses the standard [`otlphttp` exporter](https://github.com/open-telemetry/opentelemetry-collector/tree/main/exporter/otlphttpexporter) pointed at Loki's `/otlp` endpoint, rather than the contrib-repo `lokiexporter` (which pushed to Loki's older `/loki/api/v1/push` endpoint and has since been removed from `opentelemetry-collector-contrib`).

> The original internal version of this pipeline shipped to AWS Kinesis for downstream Redshift ingestion instead, which required forcing one log per batch (Kinesis rejects records over 1 MiB) and a durable file-backed sending queue. Loki has neither constraint, so this demo's version is simpler — no forced single-record batching, no persistent queue extension.

Loki only auto-indexes a fixed list of well-known OTel Resource attributes as stream labels (`service.name` among them); everything else needs to be named explicitly in Loki's own config to become an indexed label rather than unindexed structured metadata. The `transform/edge_export_labels` processor prepares bare-named log attributes for exactly the fields [k8s/loki-values.yaml](./k8s/loki-values.yaml)'s `limits_config.otlp_config.log_attributes` tells Loki to index, mirroring the label names `attributes/edge_metrics` already produces for Prometheus. In Grafana Explore, this makes queries like `{job="ingress_logs", service_name="payments-api", tls_type="mtls", status_code="500"}` possible.

## Demo

This repo ships with a one-command local demo: a [kind](https://kind.sigs.k8s.io/) cluster running [Envoy Gateway](https://gateway.envoyproxy.io/), [kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack) (Prometheus + Grafana), [Grafana Loki](https://grafana.com/oss/loki/), this collector, and five trivial demo backend services (`payments-api`, `data-api`, `connections-api`, `payouts-api`, `auth-server`) registered via Gateway API `HTTPRoute`s.

### Quickstart

Install dependencies: [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation), [helm](https://helm.sh/docs/intro/install/), [kubectl](https://kubernetes.io/docs/tasks/tools/#kubectl), [docker](https://docs.docker.com/get-docker/), [just](https://github.com/casey/just), [node](https://nodejs.org/) (for the demo UI).

```bash
just demo
```

This creates the kind cluster, installs everything above, and applies the demo apps/routes — printing the localhost ports everything is reachable on when done (no `kubectl port-forward` needed — see `k8s/kind-config.yaml`/`k8s/kind-nodeports.yaml`).

Then, in another terminal:

```bash
just demo-ui
```

Open http://localhost:4000 and send some requests through the demo UI.

Tear down with `just demo-down`.

### Demo UI

`demo-ui/` is a tiny relay (`server.mjs`, no framework, ~150 lines) plus a single static page. It exists because a browser can't set a custom `Host` header (needed to address Envoy Gateway's hostname-based routing) and would hit CORS sending JSON cross-port to the collector — so the relay does both server-side instead.

Routing convention: the first path segment of a request *to the relay* is a subdomain key that maps to the upstream `Host` header, e.g. `GET /api/payments` on the relay forwards to `Host: api.paybybank.example`, path `/payments`, at the Gateway. `GET /auth/connect/token` forwards to `Host: auth.paybybank.example`, path `/connect/token`. See the `SUBDOMAIN_HOSTS` map in [demo-ui/server.mjs](./demo-ui/server.mjs).

For every non-mTLS request, the relay *also* builds a realistic Cloudflare Logpush-shaped JSON payload from the real captured response (status, timing) and POSTs it straight at the collector's real `cloudflarereceiver` endpoint — mirroring production, where Cloudflare independently logs every non-mTLS request in parallel with Envoy. This is skipped for the `.mtls` route, since mTLS traffic never actually passes through Cloudflare.

### Categorization taxonomy

The fake demo taxonomy (`pbb.sub_domain` + `http.route` → `pbb.product` / `pbb.service.name`):

| Subdomain | Path | Product | Service |
|---|---|---|---|
| `api` | `/payments` | Payments | `payments-api` |
| `api` | `/connected-accounts` | Data | `data-api` |
| `api` | `/data-connections` | Data | `connections-api` |
| `api` | `/payouts` | Payouts | `payouts-api` |
| `auth` | `/connect/token` | Auth | `auth-server` |

Every route's `HTTPRoute` lists both its regular hostname (`api.paybybank.example`, `auth.paybybank.example`) and the corresponding `.mtls.` hostname (`api.mtls.paybybank.example`, `auth.mtls.paybybank.example`), routing to the same backend either way — purely to demonstrate the mTLS-vs-TLS ingestion split (see `k8s/demo-app/*.yaml`). Real mTLS termination is Envoy Gateway's own feature and out of scope here.

Because there's no real TLS handshake, Envoy's genuine SNI value (`%REQUESTED_SERVER_NAME%`) is always `"-"` on this listener — so `k8s/gateway/gateway.yaml`'s access log format substitutes `%REQ(:authority)%` (the Host header / `:authority` pseudo-header, present on any HTTP request) into the `requested_server_name` field the collector expects, rather than changing the collector's own config, which stays correct for a real deployment with genuine TLS. The real SNI value is still logged separately as `real_requested_server_name`, always `"-"` here, so the substitution is visible rather than silent.

`data-api` and `connections-api` also demonstrate a common real-world pattern: two distinct services rolling up to the same product (`Data`) — `pbb.service.name` still tells them apart even though `pbb.product` groups them together.

**How `pbb.product` gets set:** every demo route above carries a `sli.paybybank.example/product` annotation (see `k8s/demo-app/*.yaml`), which `scripts/generate-categorize-rules.sh` reads straight off the `HTTPRoute` and bakes into the autogenerated `transform/categorize` rules alongside `pbb.service.name` — no hand-written path-matching involved. This repo used to also carry a `transform/categorize-override` processor for products that couldn't be derived this way, but it's been removed: every product in this demo taxonomy is now annotation-driven.

## Development

The configuration for the collector resides in the root of this repo: [otel-collector-config.yaml](./otel-collector-config.yaml).

Changes to this file must be applied to the Helm deployment folder, by running `just gen`.

### Apply configuration to Helm deployment

Install just:
```bash
brew install just
```
Generate Helm configuration:
```bash
just gen
```

### Regenerate the categorize processor

The `transform/categorize` processor maps `pbb.sub_domain` (plus optional `url.path`) to `pbb.service.name` (and `pbb.product`, if possible), attributing each request log to the owning service. Its rules are autogenerated into [otel-collector-config-categorize.yaml](./otel-collector-config-categorize.yaml) by [scripts/generate-categorize-rules.sh](./scripts/generate-categorize-rules.sh) from Gateway API `HTTPRoute` resources in whatever cluster your `kubectl` context points at (the local kind demo cluster, once `just demo` has applied the routes in `k8s/demo-app/`).

Install dependencies:
```bash
brew install jq
```

Regenerate:
```bash
just gen-categorize
just gen
```

By default only `paybybank.example` (production) hostnames are emitted. Override via `CATEGORIZE_DOMAINS` (comma-separated) to include others, e.g. `CATEGORIZE_DOMAINS=paybybank.example,pbb.test`.

Warnings for any HTTPRoute entry whose app label can't be resolved are written to stderr; those rows are dropped from the output.

### Automated Testing

Automated integration tests verify that the collector correctly processes logs and generates metrics.

See [tests/README.md](tests/README.md) for more details.

Quick start:
```bash
brew install bats-core parallel jd yq
bats tests
```

## Credits

Adapted from an internal observability pipeline for a conference talk — the architecture and OTel Collector patterns are real; the company, domains, and product names are fictional. Licensed under [Apache 2.0](./LICENSE).
