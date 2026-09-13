# Metrics

The following Prometheus metrics are derived from the logs:

- [`http_edge_sli_total` counter](#http_edge_sli_total-counter)
- [`http_edge_request_duration_seconds` histogram](#http_edge_request_duration_seconds-histogram)
- [`http_edge_paybybank_latency_seconds` histogram](#http_edge_paybybank_latency_seconds-histogram)

These are inspired by similar application-level request metrics conventions (method/route/status-code labeled counters and histograms).

### `http_edge_sli_total` counter

This counter captures details about the request processing outcome in order to compute edge availability SLIs.

Labels:
| Label Name           | Log Field              | Notes      |
|----------------------|------------------------|------------|
| `app`                | `pbb.service.name`     |            |
| `domain`             | `url.host`             |            |
| `tls_type`           | `pbb.ingress.tls_type` |            |
| `sub_domain`         | `pbb.sub_domain`       |            |
| `product`            | `pbb.product`          |            |
| `service_name`       | `pbb.service.name`     |            |
| `sli_error_type`     | `error.pbb.sli_type`   | (optional) |

This counter can be used to alert on drops in edge availability by product or application.

### `http_edge_request_duration_seconds` histogram

This histogram captures how long it took to process incoming HTTP requests at the edge.

Labels:
| Label Name     | Log Field                   |
|----------------|-----------------------------|
| `app`          | `pbb.service.name`          |
| `domain`       | `url.host`                  |
| `tls_type`     | `pbb.ingress.tls_type`      |
| `sub_domain`   | `pbb.sub_domain`            |
| `product`      | `pbb.product`               |
| `service_name` | `pbb.service.name`          |
| `http_response_status_code` | `http.response.status_code` |

This histogram can be used to alert on latency spikes or specific status codes.

### `http_edge_paybybank_latency_seconds` histogram

This histogram captures how long it took to process incoming HTTP requests at the edge, less time waiting on dependencies outside the platform's control.

Labels:
| Label Name     | Log Field                   |
|----------------|-----------------------------|
| `app`          | `pbb.service.name`          |
| `domain`       | `url.host`                  |
| `tls_type`     | `pbb.ingress.tls_type`      |
| `sub_domain`   | `pbb.sub_domain`            |
| `product`      | `pbb.product`               |
| `service_name` | `pbb.service.name`          |
| `http_response_status_code` | `http.response.status_code` |

This histogram can be used to alert on latency spikes or specific status codes.