# AICLIPER — Cloud SQL PostgreSQL & Staged Migration Guide (Fase 0C)

AICLIPER menggunakan strategi **Staged Migration** dari SQLite (`data/klipcast.sqlite`) menuju **Google Cloud SQL PostgreSQL** dengan **Drizzle ORM** (`src/db/schema.ts`, `src/db/index.ts`, `src/db/drizzle.config.ts`). SQLite tidak pernah dihapus selama migrasi agar rollback tetap aman.

## 1. Provision Cloud SQL PostgreSQL Instance `[PRODUCTION-MUTATING]`

```bash
gcloud sql instances create "${SQL_INSTANCE_NAME}" \
  --database-version=POSTGRES_16 \
  --tier=db-custom-2-7680 \
  --region="${GCP_REGION}" \
  --storage-type=SSD \
  --storage-size=50GB \
  --storage-auto-increase \
  --backup-start-time=19:00 \
  --enable-point-in-time-recovery \
  --retained-backups-count=14 \
  --project="${GCP_PROJECT_ID}"

gcloud sql databases create "${SQL_DB_NAME}" \
  --instance="${SQL_INSTANCE_NAME}" \
  --project="${GCP_PROJECT_ID}"

gcloud sql users create "${SQL_USER}" \
  --instance="${SQL_INSTANCE_NAME}" \
  --password="<STRONG_GENERATED_PASSWORD>" \
  --project="${GCP_PROJECT_ID}"
```

## 2. Konfigurasi Koneksi (Cloud Run Unix Socket & TCP)

`src/db/index.ts` mendukung nama variabel standar dan alias Cloud SQL:
- Cloud Run (Unix Socket): `SQL_INSTANCE_CONNECTION_NAME` atau `CLOUD_SQL_CONNECTION_NAME` (`project:region:instance` -> otomatis memakai `/cloudsql/<connection_name>`).
- Lokal / Cloud SQL Auth Proxy (TCP): `SQL_HOST`, `SQL_PORT`, `SQL_SSL=true`.
- Kredensial: `SQL_DB_NAME` / `CLOUD_SQL_DATABASE`, `SQL_USER` / `CLOUD_SQL_USER`, `SQL_PASSWORD` (dari Secret Manager).
- Pool & Retry: `PG_POOL_MAX` (default `10`), `PG_IDLE_TIMEOUT_MS` (default `30000`), `PG_CONNECT_TIMEOUT_MS` (default `5000`), serta helper `withPgRetry()` untuk retry eksponensial pada transient connection error.

## 3. Jalankan Drizzle Schema Migration `[PRODUCTION-MUTATING]`

Gunakan Cloud SQL Auth Proxy dari workstation/CI operator untuk mendorong schema Drizzle:

```bash
# Terminal 1: Cloud SQL Auth Proxy
cloud-sql-proxy "${SQL_INSTANCE_CONNECTION_NAME}" --port=5432

# Terminal 2: Push schema Drizzle (idempotent)
SQL_HOST=127.0.0.1 SQL_PORT=5432 SQL_DB_NAME="${SQL_DB_NAME}" \
SQL_USER="${SQL_USER}" SQL_PASSWORD="<secret>" SQL_SSL=false \
npx drizzle-kit push --config=src/db/drizzle.config.ts
```

## 4. Staged Data Migration dari SQLite ke PostgreSQL

1. **Backup SQLite terlebih dahulu `[SAFE]`**:
   ```bash
   cp data/klipcast.sqlite "data/klipcast.pre-migration.$(date +%Y%m%d%H%M%S).sqlite"
   ```
2. **Dry-run migrasi `[SAFE]`**:
   ```bash
   node scripts/migrate-sqlite-to-postgres.ts --dry-run
   ```
3. **Eksekusi migrasi non-destruktif (idempotent upsert) `[PRODUCTION-MUTATING]`**:
   ```bash
   node scripts/migrate-sqlite-to-postgres.ts
   ```
   Script `scripts/migrate-sqlite-to-postgres.ts` menyalin `users`, `episodes`, `clips`, `render_jobs`, `clip_camera_settings`, `user_intro_templates`, dan `intro_template_versions` dengan `ON CONFLICT DO NOTHING / DO UPDATE` serta melaporkan perbandingan row-count SQLite vs PostgreSQL.

## 5. Verifikasi Post-Migration `[SAFE]`

- Jalankan `node scripts/verify-live-gcp.ts --skip-gcs-write --json` dan pastikan:
  - `checks.database.configured === true`
  - `checks.database.authenticated === true`
  - `checks.database.connected === true`
  - `checks.database.operational === true` (menandakan tabel Drizzle seperti `render_jobs` & `users` benar-benar ada)
- Periksa `/api/v3/readiness` pada layanan API dan pastikan `database.backend === "postgresql"` dan `database.activeMode === "postgresql_cloud_sql"`.
