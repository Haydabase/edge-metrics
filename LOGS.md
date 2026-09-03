# Log fields

The following common fields are extracted / derived from the existing fields on both Cloudflare and Envoy Gateway logs:

| Log Field | Description | Value | Notes |
|-----------|--------------|-------|-------|
| `pbb.ingress.layer` | The type of ingress log | `cloudflare`<br>`envoy` | |
| `pbb.ingress.tls_type` | mTLS traffic or not | `non-mtls`<br>`mtls` | Derived from `url.host` |
| `pbb.domain` | Hostname, without port, removing any `mtls`, resulting in the same value across mTLS vs non-mTLS requests | e.g. `api.paybybank.example` | Derived from `url.host` |
| `pbb.sub_domain` | The sub-domain of the main product domain | e.g. `api` | Derived from `pbb.domain` |
| `pbb.product` | The product the request is associated with | e.g. `Payments`,`Payouts`,`Auth`,`Data` etc. | Derived from `pbb.sub_domain` and `http.route` |
| `pbb.service.name` | The `service.name` of the application the request should be routed to | e.g. `payments-api`,`auth-server` etc. | Derived from `pbb.sub_domain` and `http.route` |
| `pbb.operation` | The HTTP method and route | e.g. `GET /payments/{id}` | Derived from `http.request.method` + `http.route` |
| `url.host` | Hostname, without port | e.g. `api.mtls.paybybank.example` | |
| `url.path` | HTTP request path | e.g. `/payments/619305e1-7fca-4a1f-b7a2-3197e5e2c1b0` | |
| `url.port` | HTTP request port (if specified) | e.g. `443` | |
| `http.route` | HTTP request path, with UUIDs replaced with `{id}` | e.g. `/v3/payments/{id}` | Derived from `url.path` |
| `http.request.method` | HTTP request method | e.g. `POST` | |
| `http.response.status_code` | HTTP status code (`integer`) | e.g. `200` | |
| `http.request.received_at` | The time the HTTP request was received (UTC ISO DateTime) | e.g. `2025-12-25T12:30:23.566Z` | |
| `http.response.sent_at` | The time an HTTP response was sent (UTC ISO DateTime) | e.g. `2025-12-25T12:30:24.013Z` | |
| `error.pbb.sli_type` | The type of error, if the request errored - using the SLI type returned from the application, otherwise based on the status code. Service-side errors (5xx fallback and app-reported internal dependency failures) are combined into a single `service_level_error` category | `invalid_request_error`<br>`service_level_error`<br>`external_dependency_error` | Derived from `pbb.app.error.sli_type` or `http.response.status_code` |
| `pbb.latency.duration_ms` | The total duration of the HTTP request | e.g. `52` | |
| `pbb.latency.time_to_first_byte_ms` | The time between receiving the first byte of the request and sending the first byte of the response | e.g. `46` | |
| `pbb.latency.external_dependency_ms` | The time spent waiting on third parties not included in our client SLAs | e.g. `21` | Equal to `pbb.app.latency.external_dependency_ms` if present, otherwise `0` |
| `pbb.latency.paybybank_ms` | The total duration of the HTTP request, excluding time spent waiting on third parties not included in our client SLAs | e.g. `31` | Derived from `pbb.latency.duration_ms` - `pbb.latency.external_dependency_ms` |
| `pbb.latency.paybybank_time_to_first_byte_ms` | The time between receiving the first byte of the request and sending the first byte of the response, excluding time spent waiting on third parties not included in our client SLAs | e.g. `25` | Derived from `pbb.latency.time_to_first_byte_ms` - `pbb.latency.external_dependency_ms` |
| `pbb.client.id` | The client ID on who's behalf the request is being made. | e.g. `testclient-34867` | Derived from `pbb.app.client.id` (only set if the application returns a client ID via the `pbb-meta` response header) |
| `user_agent.original` | The `user-agent` HTTP request header | e.g. `Mozilla/5.0 (Windows NT 10.0; Win64; x64)` | |
| `cf.ray_id` | The Cloudflare Ray ID | e.g. `83b4c2f5e8a2b1c3` | |

The following are also extracted / derived, but are primarily for deriving other fields, and are left on the logs for debugging purposes:

| Log Field | Description | Value | Notes |
|-----------|--------------|-------|-------|
| `http.response.headers.pbb-meta.decoded` | The `pbb-meta` HTTP response header returned by applications, base64 decoded to result in a JSON string | e.g. `{\"pbb.latency.external_dependency_ms\":2}` | |
| `pbb.app.client.id` | The `pbb-client-id` returned from the application in the `pbb-meta` response header | e.g. `testclient-34867` | Extracted from `http.response.headers.pbb-meta.decoded` JSON |
| `pbb.app.error.sli_type` | The `error.pbb.sli_type` returned from the application in the `pbb-meta` response header | e.g. `external_dependency_error` | Extracted from `http.response.headers.pbb-meta.decoded` JSON |
| `pbb.app.latency.external_dependency_ms` | The `pbb.latency.external_dependency_ms` returned from the application in the `pbb-meta` response header | e.g. `21` | Extracted from `http.response.headers.pbb-meta.decoded` JSON |