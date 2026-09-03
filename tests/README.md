# Automated Tests

This directory contains automated integration tests for the OpenTelemetry Collector configuration using [BATS (Bash Automated Testing System)](https://github.com/bats-core/bats-core).

## Overview

These tests verify that the OTel Collector correctly processes Cloudflare and Envoy logs through the full transformation pipeline, producing:
1. **Enriched edge logs** with all expected fields (pbb.product, pbb.service.name, error classification, etc.)
2. **Prometheus metrics** with correct labels and values

## Test Architecture

### Configuration Merge

The test suite uses a **config overlay** approach: the real collector config is merged with test-only additions/overrides at run time, so tests exercise the actual production pipeline rather than a parallel test-specific one:
- **Base**: [otel-collector-config.yaml](../otel-collector-config.yaml) - Production config
- **Overlay (merge)**: [tests/overlay-merge.yaml](overlay-merge.yaml) - Additive test content
- **Overlay (override)**: [tests/overlay-override.yaml](overlay-override.yaml) - Content that replaces base values (currently empty — kept as a hook for future test-only overrides)
- **Merged**: `otel-collector-config.yaml` - Generated at test runtime

The merge overlay adds:
- OTLP HTTP receivers (ports 4315/4316) for sending test logs
- File exporter for edge logs (to enable output assertions)
- Updates edge pipeline to export to both file and count/edge

```bash
# Merge happens automatically in setup_file() — two stages:
#   1. `*+` appends arrays (additive content)
#   2. `*`  replaces arrays (override content)
yq eval-all '. as $item ireduce ({}; . *+ $item)' \
  otel-collector-config.yaml \
  overlay-merge.yaml \
  > merged.yaml

yq eval-all '. as $item ireduce ({}; . * $item)' \
  merged.yaml \
  overlay-override.yaml \
  > otel-collector-config.yaml
```

### Test Flow

```
Test Input (OTLP JSON)
  → OTel Collector (Docker)
    → [otlp/cloudflare or otlp/envoy receivers]
    → [transformation processors]
    → [filter/edge]
    → [count/edge connector]
    ├─→ [file exporter] → /output/edge.jsonl
    └─→ [prometheus exporter] → :3001/metrics

Assertions:
  1. Compare edge logs: jd -setkeys key expected-edge.json actual-edge.json
     (uses -setkeys to treat "attributes" array as unordered set by "key" field)
  2. Verify metrics: grep expected-metrics.txt in actual metrics output
```

## Prerequisites

### Install Dependencies

```bash
# BATS testing framework
brew install bats-core

# GNU parallel (required for parallel test execution with bats --jobs)
brew install parallel

# JSON diff tool (for comparing expected vs actual logs)
brew install jd

# YAML processor (required for config generation)
brew install yq

# Docker (for running OTel Collector)
# Already installed per main README
```

### Verify Installation

```bash
which bats      # /opt/homebrew/bin/bats
which parallel  # /opt/homebrew/bin/parallel
which jd        # /opt/homebrew/bin/jd
which yq        # /opt/homebrew/bin/yq
which docker    # /usr/local/bin/docker
```

## Running Tests

**Note:** All commands should be run from the project root directory.

### Run All Tests (parallel)

Tests are split across 5 `.bats` files, each starting its own OTel Collector instance on unique ports. Use `--jobs` to run them in parallel:

```bash
bats --jobs 6 tests
```

### Run All Tests (sequential)

```bash
bats tests
```

### Run a Single Test File

```bash
bats tests/test-sli.bats
```

### Run a Single Test

```bash
bats tests/test-basics.bats --filter "cloudflare-basic"
```

### Debug Mode

Show detailed output including all commands:

```bash
bats tests/ --verbose-run
```

### Troubleshooting

If tests fail, check the following:

1. **Collector logs** (container name includes the port offset):
   ```bash
   docker logs otel-collector-test-0
   ```

2. **Test output files** (each file group has its own output directory):
   ```bash
   cat tests/output/test-0/edge.jsonl
   ```

3. **Metrics endpoint** (port varies by test file, base is 3001):
   ```bash
   curl http://localhost:3001/metrics | grep http_edge
   ```

4. **Clean up stuck containers:**
   ```bash
   docker ps -a --filter "name=otel-collector-test" --format "{{.Names}}" | xargs -r docker rm -f
   ```

## Test Data Structure

Each test case directory contains:

```
test-name/
├── input.json              # OTLP JSON payload sent to collector
├── expected-edge.json      # Expected edge log output (for non-filtered tests)
└── expected-metrics.txt    # Expected Prometheus metric snippets
```

### input.json Format

OTLP JSON format with `resourceLogs` structure:
- Cloudflare tests: Use Cloudflare-specific attributes (`ClientRequestHost`, `EdgeResponseStatus`, etc.)
- Envoy tests: Use Envoy-specific attributes (`requested_server_name`, `response_code`, etc.)

### expected-edge.json Format

OTLP JSON format with enriched attributes e.g.:
- `pbb.ingress.layer`, `pbb.domain`, `pbb.product`, `pbb.service.name`
- `pbb.latency.duration_ms`, `pbb.latency.paybybank_ms`
- `http.route` (with IDs replaced), `pbb.operation`
- etc.

### expected-metrics.txt Format

Prometheus metric lines (without counter values):
```
http_edge_sli_total{app="auth-server",domain="auth.paybybank.example",product="Auth",service_name="auth-server",sli_error_type="",sub_domain="auth",tls_type="non-mtls"}
http_edge_request_duration_seconds_count{app="auth-server",domain="auth.paybybank.example",product="Auth",service_name="auth-server",status_code="200",sub_domain="auth",tls_type="non-mtls"}
http_edge_paybybank_latency_seconds_count{app="auth-server",domain="auth.paybybank.example",product="Auth",service_name="auth-server",status_code="200",sub_domain="auth",tls_type="non-mtls"}
```

## Adding New Tests

1. **Create test directory** with a unique name:
   ```bash
   mkdir tests/cloudflare-my-new-test
   ```

2. **Create input and expected output files** — copy from a similar test case:
   - `input.json` — ensure the `RayID` (cloudflare) or `cf-ray` (envoy) value matches the directory name exactly (used for output matching)
   - `expected-edge.json` — ensure `cf.ray_id` also matches the directory name
   - `expected-metrics.txt` — Prometheus metric labels to check (omit for filtered tests)

3. **Add test entry** to the appropriate `.bats` file:
   ```bash
   @test "cloudflare-my-new-test" {
     run_cloudflare_test
   }
   ```

4. **Run test:**
   ```bash
   bats tests/test-basics.bats --filter "cloudflare-my-new-test"
   ```

## CI/CD Integration

Tests run in GitHub Actions using `bats --jobs 6` for parallel execution. See [.github/workflows/ci.yaml](../.github/workflows/ci.yaml) for the full configuration.

## Test File Structure

Tests are split across multiple `.bats` files for parallel execution. Each file starts its own OTel Collector on unique ports (offset by `PORT_OFFSET`):

| File | Tests | Port Offset |
|------|-------|-------------|
| `test-basics.bats` | Basic, missing fields, hostname | 0 |
| `test-ext-latency.bats` | External latency variations | 10 |
| `test-sli.bats` | SLI error types and fallbacks | 20 |
| `test-cat-api.bats` | API subdomain categorisation | 30 |
| `test-cat-auth.bats` | Auth subdomain categorisation | 40 |

Shared logic lives in `helpers/`:
- `helpers/setup.bash` — `setup_file()`/`teardown_file()` with per-file Docker collector instances
- `helpers/common.bash` — `run_test()`, `run_cloudflare_test()`, `run_envoy_test()`

## Performance

Expected test execution time:
- Setup: ~10-15 seconds per collector (Docker pull + start), runs in parallel
- Each test: ~1-3 seconds (send log + poll for output + verify)
- Full suite with `--jobs 6`: ~1-2 minutes wall time

## Related Documentation

- [Main README](../README.md) - OTel Collector configuration overview
- [Demo UI](../demo-ui/) - Interactive local demo (real requests via Envoy Gateway + simulated Cloudflare pushes)
- [BATS documentation](https://bats-core.readthedocs.io/) - BATS framework docs
