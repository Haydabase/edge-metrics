#!/usr/bin/env bats

PORT_OFFSET=30
load helpers/setup
load helpers/common

@test "cloudflare-cat-api-payments" {
  run_cloudflare_test
}

@test "envoy-cat-api-payments" {
  run_envoy_test
}

@test "cloudflare-cat-api-payouts" {
  run_cloudflare_test
}

@test "envoy-cat-api-payouts" {
  run_envoy_test
}

@test "cloudflare-cat-api-connected-accounts" {
  run_cloudflare_test
}

@test "envoy-cat-api-connected-accounts" {
  run_envoy_test
}

@test "cloudflare-cat-api-data-connections" {
  run_cloudflare_test
}

@test "envoy-cat-api-data-connections" {
  run_envoy_test
}
