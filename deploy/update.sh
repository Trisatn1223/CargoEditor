#!/usr/bin/env bash
# Installed once at /usr/local/sbin/cargo-editor-update.
# Build the newest main commit, health-check it, then remember the deployment.
set -Eeuo pipefail
umask 022
repo_dir=/opt/cargo-editor
state_dir=/var/lib/cargo-editor
mkdir -p "$state_dir"
exec 9>"$state_dir/update.lock"
flock -n 9 || exit 0
if [[ -f /etc/cargo-editor-update.env ]]; then
  # This is a root-owned operator configuration, never a fetched repository file.
  source /etc/cargo-editor-update.env
fi
cd "$repo_dir"
[[ "$(git remote get-url origin)" == 'https://github.com/Trisatn1223/CargoEditor.git' ]] || { echo 'Unexpected repository origin.' >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo 'Tracked local changes found; update stopped.' >&2; exit 1; }
git fetch --prune origin main
commit="$(git rev-parse origin/main)"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || exit 1
previous=''
[[ ! -f "$state_dir/current" ]] || previous="$(cat "$state_dir/current")"
if [[ "$commit" == "$previous" && "${1:-}" != '--force' ]]; then exit 0; fi
git merge --ff-only origin/main
image="cargo-editor:$commit"
docker build --pull --build-arg "BUILD_COMMIT=$commit" --tag "$image" .
# Probe the candidate image before replacing the running container.
probe="cargo-editor-probe-$$"
cleanup() { docker rm -f "$probe" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$probe" --read-only --tmpfs /tmp:rw,size=32m,mode=1777 --cap-drop ALL --security-opt no-new-privileges "$image" >/dev/null
probe_ok=false
for attempt in {1..20}; do
  if docker exec "$probe" wget -q -O /dev/null http://127.0.0.1:8080/healthz; then probe_ok=true; break; fi
  sleep 1
done
$probe_ok || { echo 'Candidate failed its static-server health check.' >&2; exit 1; }
cleanup
compose=(docker compose)
read -r -a files <<< "${COMPOSE_FILES:-compose.yaml}"
for file in "${files[@]}"; do compose+=(-f "$file"); done
compose+=(--project-name cargo-editor)
export PROXY_NETWORK="${PROXY_NETWORK:-proxy}"
export CARGO_EDITOR_IMAGE="$image" BUILD_COMMIT="$commit"
if ! "${compose[@]}" up -d --no-build --wait --wait-timeout 60; then
  if [[ "$previous" =~ ^[0-9a-f]{40}$ ]]; then
    export CARGO_EDITOR_IMAGE="cargo-editor:$previous" BUILD_COMMIT="$previous"
    "${compose[@]}" up -d --no-build --wait --wait-timeout 60 || true
  fi
  echo 'Deployment failed; previous image restored where available.' >&2
  exit 1
fi
if [[ -n "$previous" ]]; then printf '%s\n' "$previous" > "$state_dir/previous"; fi
printf '%s\n' "$commit" > "$state_dir/current.tmp"
mv "$state_dir/current.tmp" "$state_dir/current"
echo "Cargo Editor deployed: $commit"
