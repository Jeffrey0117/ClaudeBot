#!/bin/bash
# ClaudeBot Secrets Restore
# Usage: bash restore-secrets.sh [backup-name]
# List backups: bash restore-secrets.sh --list

set -e

BASE="C:/Users/jeffb/Desktop/code"
BACKUP_DIR="$BASE/ClaudeBot/.backups"

if [ "$1" = "--list" ] || [ -z "$1" ]; then
  echo "Available backups:"
  echo ""
  for d in "$BACKUP_DIR"/*/; do
    if [ -d "$d" ]; then
      name=$(basename "$d")
      count=$(ls "$d" | wc -l)
      echo "  $name ($count files)"
    fi
  done
  echo ""
  echo "Usage: bash restore-secrets.sh <backup-name>"
  exit 0
fi

NAME="$1"
SOURCE="$BACKUP_DIR/$NAME"

if [ ! -d "$SOURCE" ]; then
  echo "ERROR: Backup '$NAME' not found"
  echo "Run: bash restore-secrets.sh --list"
  exit 1
fi

echo "Restoring from: $SOURCE"
echo ""

for f in "$SOURCE"/*; do
  filename=$(basename "$f")

  # Parse: ClaudeBot__filename or ClaudeBot--botN__filename
  project=$(echo "$filename" | sed 's/__.*$//' | sed 's/__/\//')
  target_file=$(echo "$filename" | sed 's/^[^_]*__//')

  # Convert project separator back
  if [[ "$project" == ClaudeBot--* ]]; then
    dest="$BASE/$project/$target_file"
  else
    dest="$BASE/ClaudeBot/$target_file"
  fi

  cp "$f" "$dest"
  echo "  [OK] $dest"
done

echo ""
echo "Restore complete!"
