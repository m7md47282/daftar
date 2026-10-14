#!/usr/bin/env bash
# Publish the tester demo: one e2-medium in me-central1 running docker-compose.prod.yml.
# Dammam (me-central2) is not enabled on this billing account, so the VM lives in Qatar.
#   pnpm deploy:demo
# Overrides: GCP_PROJECT, GCP_ACCOUNT, GCP_ZONE, GCP_INSTANCE, GCP_MACHINE, PUBLIC_ORIGIN
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${GCP_PROJECT:-pacioli-495618}"
ACCOUNT="${GCP_ACCOUNT:-caspperofficial@gmail.com}"
ZONE="${GCP_ZONE:-me-central1-a}"
INSTANCE="${GCP_INSTANCE:-daftar-demo}"
MACHINE="${GCP_MACHINE:-e2-medium}"

g() { gcloud --project="$PROJECT" --account="$ACCOUNT" --quiet "$@"; }

if ! g compute firewall-rules describe daftar-demo-http >/dev/null 2>&1; then
  g compute firewall-rules create daftar-demo-http \
    --network=default --direction=INGRESS --action=ALLOW \
    --rules=tcp:80 --source-ranges=0.0.0.0/0 \
    --target-tags=daftar-web \
    --description="Public HTTP for the daftar demo"
fi

if ! g compute instances describe "$INSTANCE" --zone="$ZONE" >/dev/null 2>&1; then
  startup=$(mktemp)
  cat >"$startup" << 'EOF'
#!/bin/bash
set -eux
apt-get update
apt-get install -y docker.io docker-compose-v2
systemctl enable --now docker
EOF
  g compute instances create "$INSTANCE" \
    --zone="$ZONE" \
    --machine-type="$MACHINE" \
    --boot-disk-size=30GB \
    --boot-disk-type=pd-standard \
    --image-family=ubuntu-2404-lts-amd64 \
    --image-project=ubuntu-os-cloud \
    --tags=daftar-web \
    --metadata-from-file=startup-script="$startup"
  rm -f "$startup"
  echo "waiting for docker on $INSTANCE"
  for _ in $(seq 1 40); do
    if g compute ssh "$INSTANCE" --zone="$ZONE" --command='docker --version' >/dev/null 2>&1; then
      break
    fi
    sleep 10
  done
fi

IP=$(g compute instances describe "$INSTANCE" --zone="$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
ORIGIN="${PUBLIC_ORIGIN:-http://$IP}"

bundle=$(mktemp -d)
COPYFILE_DISABLE=1 tar \
  --exclude node_modules --exclude dist --exclude .git --exclude storage --exclude coverage \
  -czf "$bundle/src.tgz" .
g compute scp "$bundle/src.tgz" "$INSTANCE:/tmp/daftar-src.tgz" --zone="$ZONE"
rm -rf "$bundle"

g compute ssh "$INSTANCE" --zone="$ZONE" --command="bash -s $(printf '%q' "$ORIGIN")" << 'REMOTE'
set -euo pipefail
ORIGIN=$1
sudo mkdir -p /opt/daftar
if [[ -f /opt/daftar/.env ]]; then
  sudo cp /opt/daftar/.env /tmp/daftar-keep.env
fi
sudo find /opt/daftar -mindepth 1 -maxdepth 1 -exec rm -rf {} +
sudo tar -xzf /tmp/daftar-src.tgz -C /opt/daftar
if [[ -f /tmp/daftar-keep.env ]]; then
  sudo cp /tmp/daftar-keep.env /opt/daftar/.env
  sudo rm -f /tmp/daftar-keep.env
fi
sudo python3 - "$ORIGIN" << 'PY'
import secrets, string, sys
from pathlib import Path
origin = sys.argv[1]
env_path = Path("/opt/daftar/.env")
lines = env_path.read_text().splitlines()
weak = {"password123", "change-me-now", ""}
out, seen, generated = [], False, None
for line in lines:
    if line.startswith("SUPERADMIN_PASSWORD="):
        pw = line.split("=", 1)[1].strip().strip('"').strip("'")
        if pw in weak:
            pw = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(20))
            generated = pw
        out.append("SUPERADMIN_PASSWORD=" + pw)
        seen = True
    else:
        out.append(line)
if not seen:
    raise SystemExit("SUPERADMIN_PASSWORD missing from .env")
env_path.write_text("\n".join(out) + "\n")
env_path.chmod(0o600)
compose_path = Path("/opt/daftar/docker-compose.prod.yml")
compose = compose_path.read_text()
start = compose.find('WEB_ORIGIN: "')
end = compose.find('"', start + len('WEB_ORIGIN: "'))
if start < 0 or end < 0:
    raise SystemExit("WEB_ORIGIN missing from docker-compose.prod.yml")
compose = compose[: start + len('WEB_ORIGIN: "')] + origin + compose[end:]
compose = compose.replace('["8086:8080"]', '["80:8080"]')
if '["80:8080"]' not in compose:
    raise SystemExit("web port override missing")
compose_path.write_text(compose)
if generated:
    print("SUPERADMIN_PASSWORD=" + generated)
else:
    print("admin password already set on the server")
PY
cd /opt/daftar
sudo docker compose -p daftar-demo -f docker-compose.prod.yml build api
sudo docker compose -p daftar-demo -f docker-compose.prod.yml build web
sudo docker compose -p daftar-demo -f docker-compose.prod.yml up -d
sudo docker compose -p daftar-demo -f docker-compose.prod.yml run --rm setup
sudo rm -f /tmp/daftar-src.tgz
REMOTE

echo "demo live at $ORIGIN"
