#!/bin/sh
# Nightly backup wrapper for cron / systemd. Logs to backups/backup.log. Exit code is passed through so failures are visible.
cd "$(dirname "$0")/.." || exit 1
[ -f .env ] && set -a && . ./.env && set +a
mkdir -p "${BACKUP_DIR:-backups}"
node scripts/backup.js >> "${BACKUP_DIR:-backups}/backup.log" 2>&1
code=$?
[ $code -ne 0 ] && echo "$(date -u +%FT%TZ) backup exited with code $code" >> "${BACKUP_DIR:-backups}/backup.log"
exit $code
