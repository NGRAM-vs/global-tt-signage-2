#!/usr/bin/env bash
# Run this from inside the project folder on the VPS, after:
#   - setup.sh has already been run once
#   - this project folder has been uploaded (see README)
#   - .env has been filled in
#   - deploy/Caddyfile has your real domain name in it
#
# Usage: bash deploy/deploy.sh

set -e

echo "== Installing dependencies =="
npm install --omit=dev

echo "== Starting PostgreSQL (Docker) =="
docker compose up -d

echo "== Waiting for PostgreSQL to be ready =="
sleep 10

echo "== Starting the app with pm2 =="
pm2 start ecosystem.config.js
pm2 save

echo "== Configuring pm2 to survive server reboots =="
pm2 startup systemd -u "$USER" --hp "$HOME" | tail -n 1 | sudo bash || true

echo "== Installing Caddy config =="
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy

echo ""
echo "=================================================="
echo "Deployed. Check status with:"
echo "  pm2 status                 (is the app running?)"
echo "  pm2 logs signal-signage    (app logs)"
echo "  docker compose ps          (is PostgreSQL running?)"
echo "  sudo systemctl status caddy (is HTTPS proxy running?)"
echo ""
echo "Your app should now be reachable at https://your-domain.com"
echo "(the actual domain is whatever you put in deploy/Caddyfile)"
echo "=================================================="
