#!/usr/bin/env bash

# Shared setup/teardown for all .bats files.
# Each .bats file must set PORT_OFFSET before loading this file.
# This gives each file its own collector instance on unique ports.

export BATS_NO_PARALLELIZE_WITHIN_FILE=true

TEST_DIR=$BATS_TEST_DIRNAME
PROJECT_ROOT="$(cd "$TEST_DIR/.." && pwd)"

# Compute unique ports from offset
CF_PORT=$((4315 + PORT_OFFSET))
ENVOY_PORT=$((4316 + PORT_OFFSET))
PROM_PORT=$((3001 + PORT_OFFSET))
HEALTH_PORT=$((13133 + PORT_OFFSET))
CONTAINER_NAME="otel-collector-test-${PORT_OFFSET}"

# Each file gets its own output directory to avoid cross-file interference
OUTPUT_DIR="$TEST_DIR/output/test-${PORT_OFFSET}"

setup_file() {
  # Create isolated output directory
  mkdir -p $OUTPUT_DIR
  rm -f $OUTPUT_DIR/*
  touch $OUTPUT_DIR/edge.jsonl
  chmod 666 $OUTPUT_DIR/edge.jsonl

  # Build test config in three stages:
  #   0. `*`  merge — auto-generated categorize rules over the base
  #   1. `*+` merge — additive overlay (receivers, exporters, pipeline entries)
  #   2. `*`  merge — override overlay (currently empty; hook for future test-only overrides)
  BASE_CONFIG="$PROJECT_ROOT/otel-collector-config.yaml"
  CATEGORIZE_CONFIG="$PROJECT_ROOT/otel-collector-config-categorize.yaml"
  OVERLAY_MERGE_CONFIG="$TEST_DIR/overlay-merge.yaml"
  OVERLAY_OVERRIDE_CONFIG="$TEST_DIR/overlay-override.yaml"
  OUTPUT_CONFIG="$BATS_FILE_TMPDIR/otel-collector-config.yaml"

  echo "[$CONTAINER_NAME] Merging configs..." >&3

  yq eval-all '. as $item ireduce ({}; . * $item)' \
    "$BASE_CONFIG" \
    "$CATEGORIZE_CONFIG" \
    > "$OUTPUT_CONFIG"

  yq eval-all '. as $item ireduce ({}; . *+ $item)' \
    "$OUTPUT_CONFIG" \
    "$OVERLAY_MERGE_CONFIG" \
    > "$OUTPUT_CONFIG.tmp" \
    && mv "$OUTPUT_CONFIG.tmp" "$OUTPUT_CONFIG"

  yq eval-all '. as $item ireduce ({}; . * $item)' \
    "$OUTPUT_CONFIG" \
    "$OVERLAY_OVERRIDE_CONFIG" \
    > "$OUTPUT_CONFIG.tmp" \
    && mv "$OUTPUT_CONFIG.tmp" "$OUTPUT_CONFIG"

  echo "[$CONTAINER_NAME] Config merged successfully" >&3

  COLLECTOR_IMAGE="otel/opentelemetry-collector-contrib:latest"
  echo "[$CONTAINER_NAME] Starting OTel Collector (CF=$CF_PORT, Envoy=$ENVOY_PORT, Prom=$PROM_PORT)" >&3

  # Start collector in Docker with unique ports and container name
  docker run --name $CONTAINER_NAME \
    --detach \
    --volume $OUTPUT_CONFIG:/etc/otelcol-contrib/config.yaml \
    --volume $OUTPUT_DIR:/output \
    --publish 0.0.0.0:${CF_PORT}:4315 \
    --publish 0.0.0.0:${ENVOY_PORT}:4316 \
    --publish 0.0.0.0:${PROM_PORT}:3001 \
    --publish 0.0.0.0:${HEALTH_PORT}:13133 \
    $COLLECTOR_IMAGE

  # Wait for collector to be ready
  HOST="localhost"
  TIMEOUT=1
  RETRIES=0
  MAX_RETRIES=30

  echo "[$CONTAINER_NAME] Waiting for OTLP receivers..." >&3
  while ! nc -z -w $TIMEOUT $HOST $CF_PORT || ! nc -z -w $TIMEOUT $HOST $ENVOY_PORT; do
    RETRIES=$((RETRIES + 1))
    if [ $RETRIES -ge $MAX_RETRIES ]; then
      echo "[$CONTAINER_NAME] Collector failed to start after $MAX_RETRIES attempts" >&3
      docker logs $CONTAINER_NAME >&3
      return 1
    fi
    echo "[$CONTAINER_NAME] Waiting... (attempt $RETRIES/$MAX_RETRIES)" >&3
    sleep 1
  done

  # Wait for Prometheus endpoint
  RETRIES=0
  while ! nc -z -w $TIMEOUT $HOST $PROM_PORT; do
    RETRIES=$((RETRIES + 1))
    if [ $RETRIES -ge $MAX_RETRIES ]; then
      echo "[$CONTAINER_NAME] Prometheus endpoint failed to start" >&3
      docker logs $CONTAINER_NAME >&3
      return 1
    fi
    sleep 1
  done

  sleep 3
  echo "[$CONTAINER_NAME] Collector is ready!" >&3

  # Output collector logs for debugging
  echo "[$CONTAINER_NAME] Startup logs:" >&3
  DOCKER_LOGS=$( { docker logs $CONTAINER_NAME; } 2>&1 )
  echo "$DOCKER_LOGS" >&3
}

teardown_file() {
  docker stop $CONTAINER_NAME && docker rm $CONTAINER_NAME || true
  rm -rf $OUTPUT_DIR
}
