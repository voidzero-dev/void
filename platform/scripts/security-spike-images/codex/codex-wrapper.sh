#!/bin/sh
# codexPathOverride for the Codex SDK: always add the lockdown flags to `codex exec`.
# --ignore-user-config: CODEX_HOME/config.toml never loads; our config comes from the
# SDK's --config flags only. Fails closed if the SDK ever calls another subcommand.
set -eu
BIN=/opt/scanner/codex-bin
if [ "${1:-}" != "exec" ]; then
  echo "codex-wrapper: refusing subcommand ${1:-<none>}" >&2
  exit 64
fi
shift
exec "$BIN" exec --ephemeral --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check "$@"
