#!/usr/bin/env bats

PORT_OFFSET=10
load helpers/setup
load helpers/common

@test "cloudflare-ext-latency-none" {
  run_cloudflare_test
}

@test "envoy-ext-latency-none" {
  run_envoy_test
}

@test "cloudflare-ext-latency-zero" {
  run_cloudflare_test
}

@test "envoy-ext-latency-zero" {
  run_envoy_test
}

@test "cloudflare-ext-latency-present" {
  run_cloudflare_test
}

@test "envoy-ext-latency-present" {
  run_envoy_test
}
