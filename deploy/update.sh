#!/usr/bin/env bash
# Pulls the latest code and restarts the app. Run this by hand any time,
# or let the GitHub Actions workflow (.github/workflows/deploy.yml) call
# it automatically on every push — see README's "Automatic deploys" section.

set -e

echo "== Pulling latest code =="
git pull

echo "== Installing dependencies =="
npm install --omit=dev

echo "== Restarting the app =="
pm2 restart ecosystem.config.js

echo "== Done =="
pm2 status
