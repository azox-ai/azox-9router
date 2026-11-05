#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$ARCH" == amd64 || "$ARCH" == arm64 ]]
[[ "$PLATFORM" == "linux/$ARCH" ]]

actual="sha256:$(skopeo inspect --raw "oci-archive:$IMAGE_ARCHIVE" | sha256sum | cut -d ' ' -f 1)"
if [[ "$actual" != "$IMAGE_DIGEST" ]]; then
  printf 'OCI artifact digest mismatch: expected %s, got %s\n' "$IMAGE_DIGEST" "$actual" >&2
  exit 1
fi

# Import only the runtime platform into Docker; retain the original OCI archive
# and all its attestations unchanged for publication after this check succeeds.
local_image="9router-smoke:${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${ARCH}"
skopeo copy --override-os linux --override-arch "$ARCH" \
  "oci-archive:$IMAGE_ARCHIVE" "docker-daemon:$local_image"
container="9router-platform-smoke-${GITHUB_RUN_ID}-${ARCH}"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT

docker run --detach --pull=never \
  --name "$container" \
  --platform "$PLATFORM" \
  --publish 127.0.0.1:20128:20128 \
  "$local_image"

for attempt in {1..45}; do
  if curl --fail --silent --show-error http://127.0.0.1:20128/api/health; then
    printf '%s local OCI health check passed\n' "$PLATFORM"
    exit 0
  fi
  sleep 2
done

printf '%s local OCI health check failed; container logs follow:\n' "$PLATFORM" >&2
docker logs "$container" || true
exit 1
