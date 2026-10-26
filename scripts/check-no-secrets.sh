#!/bin/bash
# Fail if anything that looks like a real secret is about to be committed.
# Usage:
#   bash scripts/check-no-secrets.sh          # scans staged files (pre-commit),
#                                             # or all tracked files if nothing staged
#   npm run check:secrets
#
# Placeholders such as your_tailscale_api_key_here or tskey-clie... are ignored.
# Portable with bash 3.2 (macOS) and bash 4+/5 (Linux).
set -u

cd "$(dirname "$0")/.." || exit 1

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "check-no-secrets: not a git repo, skipping."
  exit 0
fi

staged=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
if [ -n "$staged" ]; then
  files_list="$staged"
else
  # Tracked files plus new (untracked, non-ignored) files so nothing
  # slips in on `git add` either.
  files_list=$(git ls-files; git ls-files --others --exclude-standard)
fi
file_count=$(printf '%s\n' "$files_list" | grep -c . || true)

# Real-secret patterns (deliberately strict; *_example and placeholder
# values containing your_/example/here/xxx/... are excluded below).
PATTERNS=(
  'tskey-[A-Za-z0-9_-]{8,}'
  'AKIA[0-9A-Z]{16}'
  'ghp_[A-Za-z0-9]{20,}'
  'gho_[A-Za-z0-9]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'xox[bpas]-[A-Za-z0-9-]{10,}'
  'sk-live-[A-Za-z0-9]{10,}'
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
)

failures=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  # Skip binary/unscannable and known-safe paths
  case "$file" in
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.woff|*.woff2|*.ttf|*.eot|*.mp4|*.pdf|package-lock.json|*.tar.gz) continue ;;
  esac
  [ -f "$file" ] || continue
  for pattern in "${PATTERNS[@]}"; do
    matches=$(grep -nIE "$pattern" "$file" 2>/dev/null | grep -viE "your_|example|here|placeholder|xxx|\.\.\.|starts with" || true)
    if [ -n "$matches" ]; then
      echo "❌ Possible secret in $file:"
      echo "$matches" | sed 's/^/    /'
      failures=1
    fi
  done
  # Quoted key=value assignments with a long value (catches pasted
  # API keys/passwords/tokens regardless of variable name).
  kv_matches=$(grep -nIE "(api[_-]?key|password|passwd|secret|token)['\"]?\s*[:=]\s*['\"][^'\"]{12,}['\"]" "$file" 2>/dev/null | grep -viE "your_|example|here|placeholder|xxx|\.\.\.|starts with" || true)
  if [ -n "$kv_matches" ]; then
    echo "❌ Possible secret assignment in $file:"
    echo "$kv_matches" | sed 's/^/    /'
    failures=1
  fi
done < <(printf '%s\n' "$files_list")

if [ "$failures" -ne 0 ]; then
  echo ""
  echo "Refusing: remove real secrets before committing/sharing."
  echo "Use .env (git-ignored) or the in-browser settings dialog instead."
  exit 1
fi

echo "✅ No secrets detected in $file_count file(s)."
