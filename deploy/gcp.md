# Deploying دفتر on Google Cloud

Target layout (region **me-central2 — Dammam, Saudi Arabia**, keeps data in the Kingdom):

| Piece | Google Cloud service |
|---|---|
| Postgres (one shared database, isolated per company by row-level security) | Cloud SQL for PostgreSQL 16, private IP |
| API (`server/Dockerfile`) | Cloud Run service `daftar-api` |
| Web (`web/Dockerfile`, nginx → proxies `/api` and `/s/` to the API) | Cloud Run service `daftar-web` |
| One-off DB setup (schema, super admin, fabric template) | Cloud Run job `daftar-setup` (same API image) |
| Demo cleanup (hourly) | Cloud Scheduler → `POST /internal/purge-demos` |
| Secrets | Secret Manager |
| Images | Artifact Registry |

## 1. One-time project setup

```bash
PROJECT=your-project; REGION=me-central2
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudscheduler.googleapis.com vpcaccess.googleapis.com
gcloud artifacts repositories create daftar --repository-format=docker --location=$REGION
```

## 2. Cloud SQL

```bash
gcloud sql instances create daftar-pg --database-version=POSTGRES_16 --region=$REGION \
  --tier=db-custom-2-7680 --network=default --no-assign-ip --backup --enable-point-in-time-recovery
gcloud sql users set-password postgres --instance=daftar-pg --password="$(openssl rand -hex 16)"
```

Notes:
- All companies live in one database (`PG_DATABASE`, default `daftar`); every company row carries `company_id`.
- The app connects as `daftar_app`, a role that owns nothing, so row-level security always applies to it.

## 3. Secrets

Create one secret per value in `.env.example` that is sensitive:
`PG_ADMIN_PASSWORD`, `PG_APP_PASSWORD`, `MASTER_KEY` (`openssl rand -hex 32`), `CRON_SECRET`, `SUPERADMIN_PASSWORD`.

```bash
printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create MASTER_KEY --data-file=-
```

**MASTER_KEY encrypts the AI and integration keys the super admin saves. Losing it means re-entering those keys; leaking it exposes them.** Rotate by re-saving each key after changing it.

## 4. Build and push

```bash
REG=$REGION-docker.pkg.dev/$PROJECT/daftar
docker build -f server/Dockerfile -t $REG/api:$(git rev-parse --short HEAD) .
docker build -f web/Dockerfile    -t $REG/web:$(git rev-parse --short HEAD) .
docker push $REG/api:… && docker push $REG/web:…
```

## 5. Cloud Run

```bash
CONN=$PROJECT:$REGION:daftar-pg
COMMON="--region=$REGION --add-cloudsql-instances=$CONN \
  --set-env-vars=PG_HOST=/cloudsql/$CONN,PG_PORT=5432,PG_ADMIN_USER=postgres,PG_APP_USER=daftar_app,SUPERADMIN_USERNAME=superadmin,CHROME_PATH=/usr/bin/chromium \
  --set-secrets=PG_ADMIN_PASSWORD=PG_ADMIN_PASSWORD:latest,PG_APP_PASSWORD=PG_APP_PASSWORD:latest,MASTER_KEY=MASTER_KEY:latest,CRON_SECRET=CRON_SECRET:latest,SUPERADMIN_PASSWORD=SUPERADMIN_PASSWORD:latest"

# setup job (run once, and again after schema/template changes)
gcloud run jobs create daftar-setup --image=$REG/api:TAG $COMMON --command=node --args=server/scripts/setup.ts
gcloud run jobs execute daftar-setup --region=$REGION --wait

# API: 1 GiB+ memory because PDF rendering runs headless Chromium
gcloud run deploy daftar-api --image=$REG/api:TAG $COMMON --memory=1Gi --cpu=1 --min-instances=1 --timeout=600 \
  --set-env-vars=WEB_ORIGIN=https://app.example.com --allow-unauthenticated

# Web
API_URL=$(gcloud run services describe daftar-api --region=$REGION --format='value(status.url)')
gcloud run deploy daftar-web --image=$REG/web:TAG --region=$REGION --timeout=600 --set-env-vars=API_URL=$API_URL --allow-unauthenticated
```

The API is reachable publicly only to serve the web app's proxy; every route (except `/healthz`, `/s/<token>`
share links and the secret-guarded cron hook) requires a browser session. There is no token/MCP access.
`--timeout=600` on both services leaves room for multi-step AI accountant requests.
To lock it down further, put both services behind one HTTPS load balancer and set the API's ingress to
`internal-and-cloud-load-balancing`.

## 6. Scheduler (expired demo cleanup)

```bash
gcloud scheduler jobs create http daftar-purge-demos --location=$REGION --schedule="0 * * * *" \
  --uri="$API_URL/internal/purge-demos" --http-method=POST --headers="x-cron-secret=$(gcloud secrets versions access latest --secret=CRON_SECRET)"
```

## 7. After the first deploy

1. Log in as `superadmin` (password from Secret Manager) → **لوحة الإدارة ← المفاتيح والتكاملات**:
   save the Anthropic API key, and optionally `ai_model` (default `claude-opus-5-5`) and `ai_credit_usd`
   (dollars of real API cost one credit buys; default 0.01).
2. **الشركات**: create each company (the manager receives a single-use invitation link), set its seats,
   and click its credit balance to top up AI credits.
3. The `daftar-setup` job creates the database and schema only when it doesn't exist yet. Once there is real
   data, a change to `db/schema.sql` needs its own migration script, run by the same job — never `--fresh`.

## 8. Custom domain

Map `app.example.com` to `daftar-web` (Cloud Run domain mapping or the load balancer), then set
`WEB_ORIGIN` on the API to that origin (it is used to build invoice share links).

## Privacy checklist before go-live
- [ ] Cloud SQL has no public IP; only Cloud Run reaches it.
- [ ] Only two people hold `roles/cloudsql.admin`; access is logged (Cloud Audit Logs → Data Access on).
- [ ] `MASTER_KEY` and DB passwords live only in Secret Manager.
- [ ] `SUPERADMIN_PASSWORD` is strong — the API refuses to start in production with a dev default, or with a malformed `MASTER_KEY`.
- [ ] `WEB_ORIGIN` is the https domain (share links are built from it).
- [ ] Backups + point-in-time recovery enabled; a restore has been tested.
- [ ] The login-page promise ("no one sees your data but you") is reviewed against who can reach the database in practice.
