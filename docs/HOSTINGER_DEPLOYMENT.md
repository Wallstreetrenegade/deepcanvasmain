# Deep Canvas office deployment on Hostinger

This deployment runs one Deep Canvas application instance behind Caddy with a private PostgreSQL 17 database. Application files are persisted at `/var/lib/deepcanvas`, PostgreSQL uses its own Docker volume, and secrets remain in an untracked `deploy/.env.production` file.

## Server and DNS

1. Provision a Hostinger VPS with the Ubuntu 24.04 Docker template.
2. Point the chosen domain or subdomain A record at the VPS IPv4 address.
3. Allow inbound TCP 22, 80, and 443 and UDP 443 in the Hostinger firewall. Restrict SSH to trusted addresses when practical.
4. Do not expose application, database, or internal WebSocket ports publicly.

## Install

```sh
sudo mkdir -p /opt/deepcanvas /var/lib/deepcanvas /var/backups/deepcanvas
sudo chown -R "$USER":"$USER" /opt/deepcanvas /var/lib/deepcanvas /var/backups/deepcanvas
git clone YOUR_PRIVATE_REPOSITORY_URL /opt/deepcanvas/app
cd /opt/deepcanvas/app/deploy
cp .env.production.example .env.production
chmod 600 .env.production
```

Fill in `.env.production`. Generate each token encryption key independently with `openssl rand -hex 32`. Never commit or paste secrets into Compose YAML.

The RingCentral application must list this exact OAuth redirect URL:

```text
https://YOUR_DOMAIN/integrations/ringcentral/callback
```

Then validate and start:

```sh
./validate-env.sh
docker compose --env-file .env.production -f compose.hostinger.yaml config --quiet
docker compose --env-file .env.production -f compose.hostinger.yaml up -d --build
docker compose -f compose.hostinger.yaml ps
curl -fsS "https://YOUR_DOMAIN/health"
```

Create the first owner account through the approved bootstrap flow, verify login, then connect the shared RingCentral account from the Call panel. Keep public signups disabled unless enrollment is actively required.

## Updates and rollback

Back up before every release:

```sh
sudo ./backup.sh
git pull --ff-only
docker compose --env-file .env.production -f compose.hostinger.yaml up -d --build
docker compose -f compose.hostinger.yaml logs --tail=200 app
```

Tag every production release in Git. Roll back by checking out the previous release tag and rebuilding; do not delete `/var/lib/deepcanvas` or the Caddy volumes.

## Operations checklist

- Schedule `backup.sh` daily and copy both the filesystem archive and PostgreSQL dump off the VPS.
- Enable Hostinger snapshots/automated backups and monitoring.
- Confirm HTTPS, WebSocket reconnect, Team Up updates, CRM changes/deletions, dialer inbound/outbound calls, recording permissions, and session recovery with two separate team accounts.
- Review application and Caddy logs after deployment.
- Rotate RingCentral, model-provider, and encryption credentials through the secret file, then recreate only the app container.
