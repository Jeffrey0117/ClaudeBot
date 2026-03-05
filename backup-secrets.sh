#!/bin/bash
# ClaudeBot Secrets Backup
# Usage: bash backup-secrets.sh [backup-name]
# Restore: bash restore-secrets.sh [backup-name]

set -e

BASE="C:/Users/jeffb/Desktop/code"
BACKUP_DIR="$BASE/ClaudeBot/.backups"
NAME="${1:-$(date +%Y%m%d_%H%M%S)}"
TARGET="$BACKUP_DIR/$NAME"

mkdir -p "$TARGET"

echo "Backing up to: $TARGET"

# Backup main ClaudeBot
for f in .env .env.bot2 .env.bot3 .env.bot4 .env.bot5 .env.bot6 .sessions.json .pairings.json .user-states.json; do
  src="$BASE/ClaudeBot/$f"
  if [ -f "$src" ]; then
    cp "$src" "$TARGET/ClaudeBot__${f}"
    echo "  [OK] ClaudeBot/$f"
  fi
done

# Backup worktree bot instances
for bot in bot1 bot2 bot3 bot4 bot5; do
  dir="$BASE/ClaudeBot--$bot"
  if [ -d "$dir" ]; then
    for f in .env .sessions.json .pairings.json .user-states.json; do
      src="$dir/$f"
      if [ -f "$src" ]; then
        cp "$src" "$TARGET/ClaudeBot--${bot}__${f}"
        echo "  [OK] ClaudeBot--$bot/$f"
      fi
    done
  fi
done

echo ""
echo "Backup complete: $TARGET"
echo "Files backed up: $(ls "$TARGET" | wc -l)"
echo ""
echo "To restore: bash restore-secrets.sh $NAME"
