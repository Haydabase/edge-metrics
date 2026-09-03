#!/usr/bin/env bats

PORT_OFFSET=20
load helpers/setup
load helpers/common

# === SLI Error Types (App-provided) ===

@test "cloudflare-sli-service-level-error" {
  run_cloudflare_test
}

@test "envoy-sli-service-level-error" {
  run_envoy_test
}

@test "cloudflare-sli-external-dep-error" {
  run_cloudflare_test
}

@test "envoy-sli-external-dep-error" {
  run_envoy_test
}

@test "cloudflare-sli-invalid-request-error" {
  run_cloudflare_test
}

@test "envoy-sli-invalid-request-error" {
  run_envoy_test
}

# === SLI Error Types (Fallback from status code) ===

@test "cloudflare-sli-no-error" {
  run_cloudflare_test
}

@test "envoy-sli-no-error" {
  run_envoy_test
}

@test "cloudflare-sli-fallback-400" {
  run_cloudflare_test
}

@test "envoy-sli-fallback-400" {
  run_envoy_test
}

@test "cloudflare-sli-fallback-500" {
  run_cloudflare_test
}

@test "envoy-sli-fallback-500" {
  run_envoy_test
}
