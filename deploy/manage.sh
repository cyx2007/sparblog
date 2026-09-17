#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Only release/config data is parsed. Never source a downloaded env file.
SELF_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ROOT=$SELF_DIR
CHANGING=0
OLD=''
NEW=''
export SITE_ADDRESS='' HTTP_PORT='' HTTPS_PORT=''

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "Missing command: $1"; }
version_ok() { [[ $1 =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; }

load_release() {
  local manifest_key manifest_value count=0 seen=' '
  while IFS='=' read -r manifest_key manifest_value || [[ -n $manifest_key ]]; do
    [[ $seen != *" $manifest_key "* ]] || die 'Duplicate release field.'
    case "$manifest_key" in
      RELEASE_VERSION) version_ok "$manifest_value" || die 'Invalid release version.' ;;
      RELEASE_PLATFORM) [[ $manifest_value == linux/amd64 || $manifest_value == linux/arm64 ]] || die 'Invalid architecture.' ;;
      DATA_SCHEMA) [[ $manifest_value == 1 ]] || die 'Unsupported data schema; a migration is required.' ;;
      APP_IMAGE|CADDY_IMAGE) [[ $manifest_value =~ ^sparblog-(admin|caddy):[0-9A-Za-z.-]+$ ]] || die 'Invalid image reference.' ;;
      *) die 'Unknown release field.' ;;
    esac
    export "$manifest_key=$manifest_value"
    seen+="$manifest_key "
    count=$((count + 1))
  done < "$1/release.env"
  [[ $count == 5 ]] || die 'Incomplete release manifest.'
  local suffix=$RELEASE_VERSION-${RELEASE_PLATFORM#linux/}
  [[ $APP_IMAGE == "sparblog-admin:$suffix" && $CADDY_IMAGE == "sparblog-caddy:$suffix" ]] || die 'Image references do not match the release.'
}

load_runtime() {
  local runtime_key runtime_value count=0 seen=' '
  [[ -f $1/runtime.env && ! -L $1/runtime.env ]] || die 'Load this release before starting it.'
  while IFS='=' read -r runtime_key runtime_value || [[ -n $runtime_key ]]; do
    [[ $seen != *" $runtime_key "* && $runtime_value =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Invalid local image ID.'
    case "$runtime_key" in APP_IMAGE|CADDY_IMAGE) ;; *) die 'Invalid runtime field.' ;; esac
    export "$runtime_key=$runtime_value"
    seen+="$runtime_key "
    count=$((count + 1))
  done < "$1/runtime.env"
  [[ $count == 2 ]] || die 'Incomplete local image IDs.'
}

load_config() {
  local config_key config_value count=0 seen=' '
  [[ -f $ROOT/config.env && ! -L $ROOT/config.env ]] || die 'Installation config is missing.'
  while IFS='=' read -r config_key config_value || [[ -n $config_key ]]; do
    [[ $seen != *" $config_key "* ]] || die 'Duplicate configuration field.'
    case "$config_key" in
      COMPOSE_PROJECT_NAME) [[ $config_value =~ ^[a-z0-9][a-z0-9_-]{0,55}$ ]] || die 'Invalid project name.' ;;
      ADMIN_ORIGIN) valid_origin "$config_value" || die 'Invalid public origin.' ;;
      SITE_ADDRESS) [[ $config_value == :80 || $config_value =~ ^[A-Za-z0-9.-]+$ ]] || die 'Invalid site address.' ;;
      HTTP_PORT|HTTPS_PORT)
        [[ $config_value =~ ^[1-9][0-9]{0,4}$ ]] || die 'Invalid port.'
        ((config_value <= 65535)) || die 'Invalid port.'
        ;;
      *) die 'Unknown configuration field.' ;;
    esac
    export "$config_key=$config_value"
    seen+="$config_key "
    count=$((count + 1))
  done < "$ROOT/config.env"
  [[ $count == 5 ]] || die 'Incomplete installation config.'
  if [[ $ADMIN_ORIGIN == https://* ]]; then
    [[ $ADMIN_ORIGIN == "https://$SITE_ADDRESS" && $HTTP_PORT == 80 && $HTTPS_PORT == 443 ]] || die 'HTTPS configuration must use the same domain and ports 80/443.'
  else
    [[ $SITE_ADDRESS == :80 && $ADMIN_ORIGIN == *":$HTTP_PORT" ]] || die 'Local HTTP origin must match HTTP_PORT.'
  fi
  export INSTALL_ROOT=$ROOT
}

valid_origin() {
  [[ $1 =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ || $1 =~ ^http://(localhost|127\.0\.0\.1):[1-9][0-9]{0,4}$ ]]
}

verify_bundle() {
  local bundle=$1 file checksum count=0 seen=' '
  [[ -d $bundle && ! -L $bundle ]] || die 'Bundle must be a real directory.'
  for file in Caddyfile README.md compose.yaml images.tar manage.sh release.env SHA256SUMS; do
    [[ -f $bundle/$file && ! -L $bundle/$file ]] || die "Missing or unsafe bundle file: $file"
  done
  while read -r checksum file; do
    [[ $checksum =~ ^[a-f0-9]{64}$ && $seen != *" $file "* ]] || die 'Invalid checksum manifest.'
    case "$file" in Caddyfile|README.md|compose.yaml|images.tar|manage.sh|release.env) ;; *) die 'Unexpected checksum path.' ;; esac
    seen+="$file "
    count=$((count + 1))
  done < "$bundle/SHA256SUMS"
  [[ $count == 6 ]] || die 'Incomplete checksum manifest.'
  (cd "$bundle" && sha256sum --strict -c SHA256SUMS)
  load_release "$bundle"
  local host
  host=$(docker info --format '{{.OSType}}/{{.Architecture}}')
  host=${host/\/aarch64/\/arm64}
  host=${host/\/x86_64/\/amd64}
  [[ $host == "$RELEASE_PLATFORM" ]] || die "Wrong bundle architecture: $RELEASE_PLATFORM; Docker host: $host"
}

compose() {
  local release=$1
  shift
  load_release "$release"
  load_runtime "$release"
  docker compose --project-name "$COMPOSE_PROJECT_NAME" --project-directory "$ROOT" \
    --env-file "$ROOT/config.env" --env-file "$release/release.env" -f "$release/compose.yaml" "$@"
}

load_images() {
  local release=$1 id actual local_app local_caddy
  verify_bundle "$release"
  docker image load --input "$release/images.tar"
  for id in "$APP_IMAGE" "$CADDY_IMAGE"; do
    actual=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$id")
    [[ $actual == "$RELEASE_PLATFORM" ]] || die 'Loaded image architecture does not match manifest.'
  done
  # Classic Docker stores use config IDs; containerd stores can use manifest IDs.
  # Resolve after loading the checksummed archive, then pin this host's IDs.
  local_app=$(docker image inspect --format '{{.Id}}' "$APP_IMAGE")
  local_caddy=$(docker image inspect --format '{{.Id}}' "$CADDY_IMAGE")
  printf 'APP_IMAGE=%s\nCADDY_IMAGE=%s\n' "$local_app" "$local_caddy" > "$release/runtime.env.next"
  mv -f -- "$release/runtime.env.next" "$release/runtime.env"
  compose "$release" config --quiet
  docker run --rm --pull never --network none -e SITE_ADDRESS -e SITE_ROOT=/published/current \
    -e ADMIN_UPSTREAM=admin:4330 -v "$release/Caddyfile:/etc/caddy/Caddyfile:ro" \
    "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
}

stage() {
  local bundle=$1 destination
  verify_bundle "$bundle"
  destination=$ROOT/releases/$RELEASE_VERSION
  [[ ! -e $destination ]] || die 'Version already installed. Use rollback to select it; releases cannot be overwritten.'
  local staged
  staged=$(mktemp -d "$ROOT/releases/.incoming-XXXXXXXX")
  for file in Caddyfile README.md compose.yaml images.tar manage.sh release.env SHA256SUMS; do
    cp -- "$bundle/$file" "$staged/$file"
  done
  chmod 755 "$staged/manage.sh"
  verify_bundle "$staged"
  mv -- "$staged" "$destination"
  NEW=$destination
}

current() {
  local selected
  [[ -L $ROOT/current ]] || return 0
  selected=$(readlink "$ROOT/current")
  [[ $selected == releases/* ]] || die 'Invalid current release link.'
  version_ok "${selected#releases/}" || die 'Invalid current release link.'
  [[ -d $ROOT/$selected ]] || die 'Current release is missing.'
  printf '%s\n' "$ROOT/$selected"
}

proxy_config() {
  cp -- "$1/Caddyfile" "$ROOT/proxy/Caddyfile.next"
  chmod 644 "$ROOT/proxy/Caddyfile.next"
  mv -f -- "$ROOT/proxy/Caddyfile.next" "$ROOT/proxy/Caddyfile"
}

backup_stopped() {
  local release=$1 backup_dir name
  load_release "$release"
  load_runtime "$release"
  backup_dir=$(mktemp -d "$ROOT/backups/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")
  local mounts=()
  for name in admin_state notes settings images published caddy_data caddy_config; do
    docker volume inspect "${COMPOSE_PROJECT_NAME}_$name" >/dev/null
    mounts+=(-v "${COMPOSE_PROJECT_NAME}_$name:/data/$name:ro")
  done
  docker run --rm --pull never --network none --user 0 "${mounts[@]}" -v "$backup_dir:/backup" \
    --entrypoint sh "$CADDY_IMAGE" -c \
    'tar -czf /backup/data.tar.gz -C /data admin_state notes settings images published caddy_data caddy_config'
  cp -- "$ROOT/config.env" "$backup_dir/config.env"
  cp -- "$release/release.env" "$backup_dir/release.env"
  (cd "$backup_dir" && sha256sum data.tar.gz config.env release.env > SHA256SUMS)
  printf 'Backup: %s\n' "$backup_dir"
}

recover() {
  local result=$?
  trap - ERR
  set +e
  if [[ $CHANGING == 1 ]]; then
    if [[ -n $OLD ]]; then
      printf 'Deployment failed; restarting the previous release. Content backup is retained.\n' >&2
      proxy_config "$OLD"
      compose "$OLD" up -d --no-deps --wait --wait-timeout 120 admin
      compose "$OLD" up -d --no-deps --wait --wait-timeout 60 blog
      compose "$OLD" exec -T blog caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
      ln -s "releases/$(basename "$OLD")" "$ROOT/.recovered-$$"
      mv -Tf "$ROOT/.recovered-$$" "$ROOT/current"
    else
      printf 'First installation failed; stopping its containers. Correct the problem and run upgrade with the same bundle.\n' >&2
      compose "$NEW" stop
    fi
  fi
  exit "$result"
}
trap recover ERR

activate() {
  local target=$1
  load_images "$target"
  OLD=$(current)
  NEW=$target
  CHANGING=1
  if [[ -n $OLD ]]; then
    compose "$OLD" stop --timeout 600 admin
    backup_stopped "$OLD"
  fi
  proxy_config "$target"
  compose "$target" up -d --no-deps --wait --wait-timeout 120 admin
  compose "$target" up -d --no-deps --wait --wait-timeout 60 blog
  compose "$target" exec -T blog caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  cp -- "$target/manage.sh" "$ROOT/manage.sh.next"
  chmod 755 "$ROOT/manage.sh.next"
  mv -f -- "$ROOT/manage.sh.next" "$ROOT/manage.sh"
  ln -s "releases/$(basename "$target")" "$ROOT/.current-$$"
  mv -Tf "$ROOT/.current-$$" "$ROOT/current"
  CHANGING=0
  printf 'Active release: %s\nAdmin: %s/admin/\n' "$(basename "$target")" "$ADMIN_ORIGIN"
  printf 'Log in and build/publish to update public pages. Use manage.sh logs for the first administrator setup link.\n'
}

usage() {
  cat <<'USAGE'
First install (from the extracted bundle):
  sudo ./manage.sh install /opt/sparblog https://sparsity.tech
After installation:
  sudo /opt/sparblog/manage.sh upgrade /path/to/extracted-bundle
  sudo /opt/sparblog/manage.sh rollback v1.0.0
  sudo /opt/sparblog/manage.sh backup
  sudo /opt/sparblog/manage.sh status
  sudo /opt/sparblog/manage.sh logs
USAGE
}

command=${1:-help}
[[ $command != help && $command != --help ]] || { usage; exit 0; }
[[ $(uname -s) == Linux ]] || die 'Run deployment management on Linux.'
for tool in docker sha256sum flock realpath tar; do need "$tool"; done
docker compose version >/dev/null
if [[ $command == install ]]; then
  [[ $# == 3 ]] || die 'install requires a directory and public origin.'
  ROOT=$(realpath -m -- "$2")
  [[ $ROOT =~ ^/[A-Za-z0-9_./-]+$ && $ROOT != / && $ROOT != "$SELF_DIR" ]] || die 'Choose a separate installation directory without spaces.'
  valid_origin "$3" || die 'Use an HTTPS origin, or http://localhost:PORT for local testing.'
  mkdir -p -- "$ROOT"
fi
[[ -d $ROOT ]] || die 'Installation directory is missing.'
exec 9>"$ROOT/.deploy.lock"
flock -n 9 || die 'Another deployment command is running.'
if [[ $command == install ]]; then
  [[ ! -e $ROOT/config.env && ! -e $ROOT/current ]] || die 'Installation already exists; use upgrade.'
  verify_bundle "$SELF_DIR"
  origin=$3
  site_address=${origin#https://}
  http_port=80
  https_port=443
  if [[ $origin == http://* ]]; then
    site_address=:80
    http_port=${origin##*:}
    https_port=${SPARBLOG_HTTPS_PORT:-8443}
  fi
  cat > "$ROOT/config.env" <<EOF
COMPOSE_PROJECT_NAME=${SPARBLOG_PROJECT:-sparblog}
ADMIN_ORIGIN=$origin
SITE_ADDRESS=$site_address
HTTP_PORT=$http_port
HTTPS_PORT=$https_port
EOF
  cp -- "$SELF_DIR/manage.sh" "$ROOT/manage.sh"
  chmod 755 "$ROOT/manage.sh"
fi
load_config
mkdir -p -- "$ROOT/releases" "$ROOT/proxy" "$ROOT/backups"
case "$command" in
  install) stage "$SELF_DIR"; activate "$NEW" ;;
  upgrade)
    [[ $# == 2 ]] || die 'upgrade requires an extracted bundle directory.'
    bundle=$(realpath -- "$2")
    verify_bundle "$bundle"
    existing=$ROOT/releases/$RELEASE_VERSION
    if [[ -e $existing ]]; then
      [[ ! -L $ROOT/current ]] || die 'Version already installed; use rollback.'
      cmp -- "$existing/SHA256SUMS" "$bundle/SHA256SUMS" || die 'Previously staged release differs.'
      NEW=$existing
    else
      stage "$bundle"
    fi
    activate "$NEW"
    ;;
  rollback)
    [[ $# == 2 ]] || die 'rollback requires an installed version.'
    version_ok "$2" || die 'rollback requires an installed version.'
    activate "$ROOT/releases/$2"
    ;;
  backup)
    OLD=$(current)
    [[ -n $OLD ]] || die 'No active release.'
    NEW=$OLD
    CHANGING=1
    compose "$OLD" stop --timeout 600 admin
    backup_stopped "$OLD"
    compose "$OLD" up -d --no-deps --wait --wait-timeout 120 admin
    CHANGING=0
    ;;
  status|logs)
    active=$(current)
    [[ -n $active ]] || die 'No active release.'
    if [[ $command == status ]]; then
      printf 'Active release: %s\n' "$(basename "$active")"
      compose "$active" ps
    else
      compose "$active" logs --tail=50 admin
    fi
    ;;
  *) usage; exit 1 ;;
esac
