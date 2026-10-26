#!/bin/bash
# Installs the repo's git hooks (currently: secret scan on pre-commit).
# Usage: npm run setup:hooks
# Safe to re-run; overwrites only the hooks this repo manages.
set -u

cd "$(dirname "$0")/.." || exit 1

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "setup:hooks: not a git repo, skipping."
  exit 0
fi

HOOK_DIR=$(git rev-parse --git-dir)/hooks
mkdir -p "$HOOK_DIR"

cat > "$HOOK_DIR/pre-commit" <<'EOF'
#!/bin/sh
# Installed by `npm run setup:hooks`. Runs the tracked secret scan
# against staged changes; blocks the commit if a secret is found.
exec bash "$(git rev-parse --show-toplevel)/scripts/check-no-secrets.sh"
EOF
chmod +x "$HOOK_DIR/pre-commit"

echo "✅ Installed pre-commit hook -> scripts/check-no-secrets.sh"
