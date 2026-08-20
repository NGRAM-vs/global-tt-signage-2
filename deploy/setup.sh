#!/usr/bin/env bash
# One-time setup for a fresh Oracle Cloud "Always Free" Ubuntu ARM instance.
# Run this ONCE, right after your first SSH login, as: bash setup.sh
#
# What it does:
#   1. Installs Docker + the Docker Compose plugin (for PostgreSQL)
#   2. Installs Node.js 20 LTS
#   3. Installs pm2 (keeps the app running, restarts it if it crashes or the
#      server reboots)
#   4. Installs Caddy (automatic free HTTPS — no manual certificate steps)
#   5. Opens the right firewall ports, including Oracle's extra iptables
#      rules that block everything but SSH by default on their Ubuntu images
#      (a common surprise — the cloud console's "Security List" isn't the
#      only firewall in play here)

set -e

echo "== Updating system packages =="
sudo apt-get update -y
sudo apt-get upgrade -y

echo "== Installing Docker =="
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"

echo "== Installing Node.js 20 LTS =="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "== Installing pm2 =="
sudo npm install -g pm2

echo "== Installing Caddy =="
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update -y
sudo apt-get install -y caddy

echo "== Opening firewall ports (ufw) =="
sudo apt-get install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

echo "== Fixing Oracle's default iptables rules =="
# Oracle's stock Ubuntu image ships with iptables rules that block inbound
# traffic on everything except SSH, on top of the cloud console's Security
# List / Network Security Group. Without this, ufw's rules above won't
# actually take effect for 80/443.
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || sudo iptables-save | sudo tee /etc/iptables/rules.v4 > /dev/null || true

echo ""
echo "=================================================="
echo "Base setup complete."
echo ""
echo "Still to do:"
echo "  1. Log out and back in (so the docker group membership applies)"
echo "  2. In the Oracle Cloud console: open ports 80 and 443 on your"
echo "     instance's Security List / Network Security Group (this script"
echo "     cannot do that part for you — it's a console setting, not a"
echo "     server setting)"
echo "  3. Upload your project (see README's 'Deploying to a VPS' section)"
echo "  4. Point a domain name's DNS A record at this server's public IP"
echo "  5. Run deploy.sh from inside the project folder"
echo "=================================================="
