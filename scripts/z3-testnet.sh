#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-help}"
Z3_DIR="${Z3_DIR:-../z3}"
Z3_REVISION="${Z3_REVISION:-e84ce9fd8e864ff0b2a8a62f6ce14392145db0fb}"

case "$COMMAND" in
  setup)
    if [[ ! -d "$Z3_DIR/.git" ]]; then
      git clone --filter=blob:none --no-checkout https://github.com/ZcashFoundation/z3.git "$Z3_DIR"
    fi
    cd "$Z3_DIR"
    git fetch --depth=1 origin "$Z3_REVISION"
    git checkout --detach "$Z3_REVISION"
    test "$(git rev-parse HEAD)" = "$Z3_REVISION"
    ./scripts/setup-network.sh testnet
    echo "Z3 is ready: $Z3_DIR"
    echo "Next step: npm run z3:start"
    ;;
  start)
    cd "$Z3_DIR"
    docker compose --env-file .env.testnet up -d zebra
    echo "Zebra started. The initial testnet sync may take 2–12 hours and approximately 30 GB."
    echo "Status: cd $Z3_DIR && ./scripts/check-zebra-readiness.sh 18080"
    echo "See README > Live testnet for Zallet encryption setup."
    ;;
  status)
    cd "$Z3_DIR"
    docker compose --env-file .env.testnet ps
    curl -fsS http://127.0.0.1:18080/ready || true
    echo
    ;;
  *)
    cat <<'EOF'
Usage:
  npm run z3:setup   — generates testnet configuration from the pinned Z3 revision
  npm run z3:start   — starts Zebra; the lengthy sync is intentionally a separate step
  npm run z3:status  — shows container and readiness status

For security, the initial Zallet wallet setup is not automated; follow the official
Z3 commands in the README. This script never reads the seed or mnemonic.
EOF
    ;;
esac
