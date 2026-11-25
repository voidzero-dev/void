#!/bin/sh
# codexPathOverride for the Codex SDK: always add the lockdown flags to `codex exec`.
# --ignore-user-config: CODEX_HOME/config.toml never loads; our config comes from the
# SDK's --config flags only. Fails closed on any other subcommand, and when the binary is
# not the version this image pins (drift: see test/unit/image-pins.test.ts).
set -eu
BIN=/opt/void-scanner/codex-bin
EXPECTED_VERSION=0.169.0
if [ "${1:-}" != "exec" ]; then
  echo "codex-wrapper: refusing subcommand ${1:-<none>}" >&2
  exit 64
fi
case "$("$BIN" --version)" in
  *" $EXPECTED_VERSION") ;;
  *) echo "codex-wrapper: codex is not version $EXPECTED_VERSION" >&2; exit 65 ;;
esac
shift
exec "$BIN" exec --ephemeral --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check "$@"
