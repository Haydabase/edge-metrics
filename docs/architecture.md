# Architecture

## Ingress paths

```mermaid
flowchart TD
    Clients([Clients])
    Clients -->|TLS traffic| Cloudflare[Cloudflare]
    Clients -->|mTLS traffic| Gateway[Envoy Gateway]
    Cloudflare --> Gateway

    subgraph k8s [Kubernetes]
        Gateway --> PaymentsAPI[payments-api]
        Gateway --> DataAPI[data-api]
        Gateway --> ConnectionsAPI[connections-api]
        Gateway --> PayoutsAPI[payouts-api]
        Gateway --> AuthServer[auth-server]
    end
```

Envoy Gateway logs every request it handles (both TLS and mTLS); Cloudflare only logs non-mTLS requests. The collector treats Cloudflare's log as the "edge" log for non-mTLS traffic and Envoy's log as the "edge" log for mTLS traffic, so there's exactly one edge log per HTTP request regardless of path.

## Collector pipeline

```mermaid
flowchart LR
    CF[["cloudflare receiver\n:8088"]]
    Envoy[["otlp/envoy receiver\n:14317"]]

    CF --> PL_CF["logs/cloudflare\nfilter · attributes · transform"]
    Envoy --> PL_Envoy["logs/envoy\nattributes · transform"]

    PL_CF --> Combine["logs/ingress\nfilter · transform · categorize"]
    PL_Envoy --> Combine

    Combine --> Edge["logs/edge\nfilter (single log/request)"]

    Edge --> Count["count/edge\nsignaltometrics/edge"]
    Edge --> Export["logs/edge_export"]

    Count --> Metrics["metrics/edge\nattributes · transform"]
    Metrics --> Prom[("Prometheus\nexporter")]

    Export --> Loki[("otlphttp/edge\nexporter")]
```

## Local demo stack

```mermaid
flowchart TD
    subgraph Host [Your machine]
        DemoUI["demo-ui\nstatic page + relay\n:4000"]
    end

    subgraph Kind [kind cluster]
        subgraph NsGatewaySystem [ns: envoy-gateway-system]
            Gateway2[Envoy Gateway]
        end
        subgraph NsApps [ns: applications]
            Apps["payments-api · data-api · connections-api\npayouts-api · auth-server\n(+ their HTTPRoutes)"]
        end
        subgraph NsMetrics [ns: edge-metrics]
            Collector[OTel Collector]
        end
        subgraph NsMonitoring [ns: monitoring]
            Prom2[Prometheus]
            Grafana2[Grafana]
            Loki2[Loki]
        end

        Gateway2 -->|cross-namespace route attach| Apps
        Gateway2 -->|access logs, OTLP| Collector
        Collector -->|metrics| Prom2
        Collector -->|logs| Loki2
        Prom2 --> Grafana2
        Loki2 --> Grafana2
    end

    DemoUI -->|Host header set server-side| Gateway2
    DemoUI -->|simulated Cloudflare push| Collector
```
