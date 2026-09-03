#!/usr/bin/env bats

PORT_OFFSET=0
load helpers/setup
load helpers/common

@test "cloudflare-invalid-pbb-meta" {
  run_cloudflare_test
}

@test "envoy-invalid-pbb-meta" {
  run_envoy_test
}

@test "cloudflare-ignored-source" {
  run_cloudflare_test
}

@test "envoy-non-mtls" {
  run_envoy_test
}

@test "cloudflare-basic" {
  run_cloudflare_test
}

@test "cloudflare-with-headers" {
  run_cloudflare_test
}

@test "envoy-basic" {
  run_envoy_test
}

@test "cloudflare-missing-fields" {
  run_cloudflare_test
}

@test "envoy-missing-fields" {
  run_envoy_test
}

@test "cloudflare-hostname-with-port-80" {
  run_cloudflare_test
}

@test "cloudflare-hostname-with-port-443" {
  run_cloudflare_test
}

@test "cloudflare-hostname-with-non-standard-port" {
  run_cloudflare_test
}

@test "envoy-hostname-with-port-443" {
  run_envoy_test
}

@test "envoy-hostname-with-non-standard-port" {
  run_envoy_test
}
