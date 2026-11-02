#!/usr/bin/env sh
set -eu

source_dir="/var/lib/deepcanvas"
backup_dir="/var/backups/deepcanvas"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

test -d "$source_dir"
mkdir -p "$backup_dir"
tar -C "$source_dir" -czf "$backup_dir/deepcanvas-$stamp.tgz" .
docker exec deepcanvas-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  | gzip > "$backup_dir/deepcanvas-postgres-$stamp.sql.gz"
find "$backup_dir" -type f -name 'deepcanvas-*.tgz' -mtime +14 -delete
find "$backup_dir" -type f -name 'deepcanvas-postgres-*.sql.gz' -mtime +14 -delete
echo "$backup_dir/deepcanvas-$stamp.tgz"
echo "$backup_dir/deepcanvas-postgres-$stamp.sql.gz"
