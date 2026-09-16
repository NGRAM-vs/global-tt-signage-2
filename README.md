# Global T & T Digital Signage — self-hosted (Node + PostgreSQL + Cloudflare R2)

The same content management app — upload content, build playlists, pair
and assign screens, live updates — backed by a small Node/Express server,
PostgreSQL, and Cloudflare R2 for file storage. You run the Node server
yourself; it can be on your own PC, a spare machine, a Raspberry Pi, a VPS,
or a platform like Railway/Render. Postgres runs in Docker alongside it
(or any Postgres host you point it at), and uploaded content lives in R2
rather than on the server's own disk — which matters if you ever deploy
somewhere with an ephemeral filesystem (Railway, Render, etc.), since
nothing would be lost on a restart or redeploy.

- **`admin.html`** — the dashboard: upload content, build playlists, add
  screens and copy each one's pairing link.
- **`player.html`** — what runs on the actual screen. Pair it once with a
  6-character code (or open its direct link), then leave it running. It
  caches its last-known content locally, so a network drop or a full
  reboot doesn't blank the screen or force re-pairing — it keeps showing
  whatever it last successfully loaded until the connection comes back.
- **`server/`** — the Express server: REST API + file uploads (streamed
  straight through to R2, never stored locally) + a Server-Sent Events
  stream that pushes live updates to every connected screen and dashboard
  tab.
- **`server/storage.js`** — the Cloudflare R2 integration (upload/delete).
- **`docker-compose.yml`** — starts PostgreSQL in a container with a
  persistent volume, so your data survives container restarts.
- **`deploy/`** — config for reaching this over the internet, either via
  Cloudflare Tunnel (`deploy/cloudflare/`, your machine stays the server)
  or a standalone always-on VPS (everything else in `deploy/`, see
  "Deploying to Oracle Cloud" below). Not needed for local/same-network use.
- **`ecosystem.config.js`** — tells pm2 (a process manager) how to keep the
  app running and auto-restart it; only used for the VPS deployment path.

## Setting up Cloudflare R2 (file storage)

Do this once, before configuring `.env` in the Setup steps below.

1. **Create an R2 bucket** — Cloudflare dashboard → **R2 Object Storage** →
   **Create bucket**. Name it anything (e.g. `signal-signage`).

2. **Enable public access** for the bucket, so uploaded content can be
   shown directly on screens without extra signing logic: open the
   bucket → **Settings** → under "Public Access", enable the **R2.dev**
   subdomain. This gives you a public base URL like
   `https://pub-xxxxxxxxxxxx.r2.dev` — that's your `R2_PUBLIC_URL`.
   (You can swap this for your own custom domain later the same way.)

3. **Create an API token** scoped to R2 — Cloudflare dashboard → **R2** →
   **Manage API Tokens** → **Create API Token**. Give it **Object Read &
   Write** permission, scoped to just this bucket if you want to be
   precise. Save the **Access Key ID** and **Secret Access Key** it shows
   you — the secret is only shown once.

4. **Find your Account ID** — shown on the right side of the main R2
   Object Storage dashboard page, or on any domain's Overview page.

You now have everything for the five `R2_*` values in `.env`:
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET_NAME` (whatever you named it in step 1), and `R2_PUBLIC_URL`
(from step 2).

## Setup

1. **Install Docker** if you don't have it — [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac/Windows/Linux).

2. **Install Node.js** (18 or newer) if you don't have it — [nodejs.org](https://nodejs.org).

3. **Install dependencies**, from this folder:
   ```
   npm install
   ```

4. **Configure `.env`.** Copy `.env.example` to `.env` and fill in your
   admin login, a session secret, your Postgres password of choosing, and
   the five R2 values from the section above:
   ```
   ADMIN_EMAIL=you@example.com
   ADMIN_PASSWORD=pick-something-only-you-know
   SESSION_SECRET=any-long-random-string
   PORT=3000

   DB_HOST=127.0.0.1
   DB_PORT=5432
   DB_USER=postgres
   DB_PASSWORD=pick-a-postgres-password
   DB_NAME=signal_signage

   R2_ACCOUNT_ID=...
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   R2_BUCKET_NAME=signal-signage
   R2_PUBLIC_URL=https://pub-xxxxxxxxxxxx.r2.dev
   ```
   The `DB_USER`, `DB_PASSWORD`, and `DB_NAME` you choose here are the same
   ones the Postgres container will use in the next step — one `.env`
   drives both.

5. **Start Postgres in Docker**, from this folder:
   ```
   docker compose up -d
   ```
   This reads `DB_USER`/`DB_PASSWORD`/`DB_NAME` straight from your `.env`
   and starts a Postgres 16 container listening on port 5432, with a named
   volume so your data survives restarts (`docker compose down` stops it
   without losing data; `docker compose down -v` would wipe it, only do
   that on purpose).

6. **Start the app**:
   ```
   npm start
   ```
   You'll see `Global T & T Digital Signage is running at http://localhost:3000`.
   If it instead prints a database connection error, give the container a
   few extra seconds to finish starting up and try again — first-time
   startup takes a bit longer than subsequent restarts.

7. Open `http://localhost:3000` in a browser, sign in with the email/password
   from your `.env`, upload some content, build a playlist, and add a screen.
   It'll show a 6-character pairing code and a "Copy player link" button.

8. On the actual display, open `http://<server-address>:3000/player.html`
   and either type in the pairing code, or open the copied direct link
   (`?screen=...`), which skips typing entirely.

## Day-to-day use

- **Stopping for the day**: `Ctrl+C` the Node server; `docker compose stop`
  pauses Postgres without deleting anything.
- **Starting back up**: `docker compose up -d` then `npm start`.
- **Checking Postgres is actually running**: `docker compose ps`.
- **Viewing Postgres logs** (if the app can't connect): `docker compose logs postgres`.

## Other ways to run PostgreSQL

Docker is what's set up here, but if you'd rather not use it:

**Locally installed** (no Docker)
- Mac: `brew install postgresql@16 && brew services start postgresql@16`
- Windows/Linux: use the [PostgreSQL installer](https://www.postgresql.org/download/) or your package manager (e.g. `sudo apt install postgresql`)
- Then create the database: `createdb signal_signage` (or `psql -U postgres -c "CREATE DATABASE signal_signage;"`)
- Skip `docker-compose.yml` entirely and just point `.env` at your local install.

**Cloud-hosted (this is where Postgres genuinely has better free options than MySQL did)**
- **[Supabase](https://supabase.com)** — recommended for this app specifically. Free tier (500MB database, no credit card) pauses a project only after 7 days of *zero* activity, with no cost meter running while it's active. Since every paired screen sends a heartbeat every 25 seconds, a project effectively never goes idle long enough to pause — and unlike usage-billed alternatives, that constant activity doesn't cost anything extra either.
- **[Neon](https://neon.tech)** — free tier (0.5GB storage) works well too, but bills free-tier compute by the hour with a monthly cap, scaling to zero after ~5 minutes of inactivity. This app's constant heartbeat traffic can prevent that scale-to-zero from ever kicking in, which may burn through the free compute allowance faster than a typical low-traffic project. Still a fine choice, just keep an eye on the usage dashboard if you use this instead.
- Any other Postgres-compatible host works too (Railway, Render, AWS RDS, etc.) — create a database there, and use the host/port/username/password/database name it gives you in `.env` instead of the Docker container's.

## Making it reachable from other devices

By default the server only listens on your machine.

- **Same network** — find your machine's local IP (e.g. `192.168.1.42`) and
  use `http://192.168.1.42:3000` from other devices on the same Wi-Fi/LAN.
  (If your router isolates devices from each other — common on guest
  networks — this won't work; check for an "AP isolation" or "client
  isolation" setting.)
- **From anywhere, using your own machine as the server** — see "Reaching
  the internet with Cloudflare Tunnel" below.
- **From anywhere, independent of your own machine entirely, hosted for
  you** — see "Deploying to Railway" (paid, ~$5/month after a one-time
  trial credit) or "Deploying to Render" (free, no credit card, one real
  caveat — see that section) below. No server to maintain yourself either way.
- **From anywhere, independent of your own machine, on infrastructure you
  control** — see "Deploying to Oracle Cloud" further down instead.

## Deploying to Railway

Railway builds and runs the app for you from a GitHub repo — no server to
patch, no process manager to configure, and it gives you a free HTTPS
`*.up.railway.app` URL automatically (no domain purchase needed, unlike
the Cloudflare Tunnel path above).

**1. Push this project to GitHub**

From this folder:
```
git init
git add .
git commit -m "Initial commit"
```
Create a new empty repository on [github.com](https://github.com/new)
(don't initialize it with a README — this folder already has one), then:
```
git remote add origin https://github.com/your-username/your-repo-name.git
git branch -M main
git push -u origin main
```
Your `.env` file is already excluded via `.gitignore`, so no secrets get
pushed — Railway needs its own copy of those values, set in its dashboard
in step 3.

**2. Create the Railway project**

At [railway.app](https://railway.app), sign in (GitHub login is easiest,
since you'll be connecting a GitHub repo anyway) → **New Project** →
**Deploy from GitHub repo** → select the repo you just pushed. Railway
detects the Node.js app automatically via `package.json` and starts a
first (failing, for now) deploy — that's expected, since it doesn't have
a database or any environment variables yet.

**3. Add PostgreSQL**

In the project, **+ New** → **Database** → **Add PostgreSQL**. Railway
provisions it and exposes a `DATABASE_URL` — click into your app service
(not the database) → **Variables** → **New Variable** → **Add Reference**
→ select the Postgres service's `DATABASE_URL`. This is what `server/db.js`
picks up automatically in preference to the individual `DB_*` vars.

**4. Add the rest of your environment variables**

Still in your app service's **Variables** tab, add each of these
individually (same values as your local `.env`, plus one new one):
```
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=pick-something-only-you-know
SESSION_SECRET=any-long-random-string
NODE_ENV=production

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=signal-signage
R2_PUBLIC_URL=https://pub-xxxxxxxxxxxx.r2.dev
```
`NODE_ENV=production` matters here — it's what turns on secure,
HTTPS-only session cookies and the reverse-proxy trust setting, both of
which Railway's setup needs (Railway terminates HTTPS for you and proxies
plain HTTP internally, same idea as the Caddy setup in the Oracle path).
Don't set `PORT` — Railway assigns it automatically and the app already
reads `process.env.PORT`.

**5. Deploy and get your URL**

Railway redeploys automatically once the variables are saved. Once it
shows as live, **Settings** → **Networking** → **Generate Domain** gives
you the public `https://your-app.up.railway.app` URL. Open it, sign in,
and you're live — screens can use
`https://your-app.up.railway.app/player.html` from anywhere.

**6. Updating later**

Just `git push` your changes — Railway watches the repo and redeploys
automatically on every push to your main branch.

## Deploying to Render

Render works a lot like Railway — builds and runs the app from your
GitHub repo, gives you a free HTTPS URL — but with one important
difference for this project: **use an external Postgres host (Supabase or
Neon), not Render's own database.** Render's own free Postgres instances
expire and get deleted 30 days after creation, which makes them
unsuitable here regardless of the web service itself being free.

The other thing worth knowing going in: Render's free web services spin
down after 15 minutes with zero incoming requests, causing a ~30–60
second delay on the next one. In practice this is unlikely to bite you —
every paired screen sends a heartbeat every 25 seconds, which counts as
real traffic and should keep the service continuously warm as long as at
least one screen is connected. But Render doesn't officially guarantee
this behavior (it's a well-known community workaround, not a documented
feature), so treat "always warm" as the likely outcome, not a promise. If
every screen is ever offline at once for 15+ minutes, the next request
eats that delay — the player's local caching means a reconnecting screen
keeps showing its last content during that wait rather than going blank.

**1. Push this project to GitHub**

Same as step 1 in "Deploying to Railway" above — skip this if you already
did it there.

**2. Create a free Postgres database with Supabase**

At [supabase.com](https://supabase.com), sign up (no credit card
required), create a project, then go to **Project Settings** →
**Database** → **Connection string** (URI format) and copy it — it looks
like `postgresql://postgres:[password]@db.xxxxxxxxxxxx.supabase.co:5432/postgres`.
That's your `DATABASE_URL`. Supabase is the better fit here specifically
because its free tier only pauses after 7 days of *zero* activity, with
no cost meter running while active — your screens' constant heartbeats
keep it comfortably awake at no extra cost. (Neon works too — see "Other
ways to run PostgreSQL" above for the tradeoff if you'd rather use that
instead.)

**3. Create the Render web service**

At [render.com](https://render.com), sign in (GitHub login is easiest) →
**New** → **Web Service** → connect the repo you pushed. Render
auto-detects Node.js. Set:
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Instance Type**: Free

**4. Add environment variables**

In the new service's **Environment** tab, add each of these:
```
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=pick-something-only-you-know
SESSION_SECRET=any-long-random-string
NODE_ENV=production

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=signal-signage
R2_PUBLIC_URL=https://pub-xxxxxxxxxxxx.r2.dev
```
Same as the Railway setup, `NODE_ENV=production` turns on HTTPS-only
session cookies and the reverse-proxy trust setting Render's HTTPS
termination needs. Don't set `PORT` — Render assigns it automatically.

**5. Deploy**

Render builds and deploys automatically once you save. Your app is live
at the `https://your-app.onrender.com` URL shown at the top of the
service page — screens can use
`https://your-app.onrender.com/player.html` from anywhere.

**6. Updating later**

Same as Railway — `git push`, and Render redeploys automatically.

## Reaching the internet with Cloudflare Tunnel

This gives you a real `https://` URL that works from anywhere, without
opening any ports on your router or exposing your home IP. The trade-off:
your machine has to stay on and connected — if it's off, screens can't
reach the server. If you need screens to work even with your machine
powered down, skip to "Deploying to Oracle Cloud" instead.

**You'll need a domain added to your Cloudflare account** (any registrar is
fine — Cloudflare just needs to manage its DNS, which is free). If you
don't have one yet, this is the one unavoidable real cost in this path
(domains are typically $10–15/year). There's also a free "quick tunnel"
option with no domain needed, but it gives you a random URL that changes
every time you restart it — not workable for permanent screen pairing
links, so it's only good for a quick test.

**1. Install `cloudflared`**
```
brew install cloudflared
```

**2. Log in** (opens a browser to authenticate and pick which domain to use)
```
cloudflared tunnel login
```

**3. Create the tunnel**
```
cloudflared tunnel create signal-signage
```
This prints a **Tunnel ID** and creates a credentials file under
`~/.cloudflared/`. Note the Tunnel ID down.

**4. Fill in the config**
Open `deploy/cloudflare/config.yml` and replace the placeholders with your
actual Tunnel ID, credentials file path, and the hostname you want to use
(e.g. `signage.yourdomain.com`).

**5. Route DNS to the tunnel**
```
cloudflared tunnel route dns signal-signage signage.yourdomain.com
```
(Use the same hostname you put in `config.yml`.) This creates the DNS
record automatically — nothing to do in Cloudflare's dashboard by hand.

**6. Test it**
```
cloudflared tunnel run --config deploy/cloudflare/config.yml signal-signage
```
With your app also running (`npm start` in another terminal), visit your
hostname in a browser — you should see the landing page.

**7. Make it permanent** (auto-starts, survives logout/reboot)
```
sudo cloudflared service install --config /full/path/to/deploy/cloudflare/config.yml
```

**8. Keep the machine from sleeping**
Since this machine is now acting as your server, make sure it doesn't go
to sleep: on a Mac, **System Settings → Battery/Energy Saver** and disable
sleep while plugged in (or run `caffeinate` in a terminal you leave open,
though the `service install` step above is the more permanent fix since it
runs independent of any terminal window).

Your dashboard is now at `https://signage.yourdomain.com/admin.html` and
screens can open `https://signage.yourdomain.com/player.html` from
anywhere — as long as this machine stays on and connected.

## Deploying to Oracle Cloud (free, always-on, independent of your machine)

This gets the app running on its own server that stays up even if your own
machine is off. Steps 1–4 have to happen in Oracle's web console (only you
can do these — they involve your account and identity verification); the
scripts in `deploy/` handle everything after that.

**1. Create an Oracle Cloud account**
Go to [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) and sign
up. You'll be asked for a credit card for identity verification, but the
Always Free resources genuinely don't charge it. Choose your home region
carefully during signup — your free resources are tied to whichever region
you pick here and can't be moved later.

**2. Create the free compute instance**
In the console: **Compute → Instances → Create Instance**.
- Name it anything (e.g. `signal-signage`)
- Under "Image and shape", change the shape to **Ampere (Arm-based
  processor)**, specifically **VM.Standard.A1.Flex** — set it to 2 OCPUs /
  12 GB memory (the current free allocation)
- Keep the image as the default **Ubuntu** (a recent LTS version)
- Under "Add SSH keys", either let Oracle generate a key pair for you (download
  both files and keep them safe) or paste in your own public key
- Leave networking on the defaults (it'll assign a public IP automatically)
- Click **Create**, and wait a few minutes for it to finish provisioning

If you get an "out of capacity" error on creation, that's a known Oracle
free-tier quirk — try a different availability domain (shown in the same
form) or try again later; capacity frees up periodically.

**3. Open ports 80 and 443 in the console**
Instance details page → your subnet's **Security List** (or **Network
Security Group** if you used one) → **Add Ingress Rules** → add rules
allowing TCP on ports 80 and 443 from source `0.0.0.0/0`. Without this
step, the setup script's firewall changes won't matter — the console-level
Security List blocks traffic before it even reaches the server.

**4. Point a domain at it**
You need a real domain name for free HTTPS to work (Let's Encrypt, which
Caddy uses automatically, won't issue a certificate for a bare IP address).
If you don't already have one, a free option is
[duckdns.org](https://www.duckdns.org) — sign in, claim a free subdomain
like `yourname.duckdns.org`, and point it at your instance's public IP
(shown on the instance details page in the Oracle console).

**5. SSH in and run the setup script**
```
ssh -i /path/to/your-private-key ubuntu@<your-instance-public-ip>
```
Once connected, get `deploy/setup.sh` onto the server (simplest: paste its
contents into a new file with `nano setup.sh`, or `scp` it up from your own
machine), then:
```
bash setup.sh
```
This installs Docker, Node.js, pm2, and Caddy, and opens the server's own
firewall. Log out and back in once it finishes (needed for Docker
permissions to apply).

**6. Upload the project**
From your own machine, in this project's folder:
```
scp -i /path/to/your-private-key -r . ubuntu@<your-instance-public-ip>:~/signal-signage
```

**7. Configure it on the server**
```
ssh -i /path/to/your-private-key ubuntu@<your-instance-public-ip>
cd signal-signage
cp .env.example .env
nano .env          # fill in your real admin login + a Postgres password
nano deploy/Caddyfile   # replace your-domain.com with your real domain
```

**8. Deploy**
```
bash deploy/deploy.sh
```
This installs dependencies, starts Postgres in Docker, starts the app under
pm2 (auto-restarts on crash or reboot), and points Caddy at it with
automatic HTTPS.

Your dashboard is now at `https://your-domain.com/admin.html`, reachable
from anywhere, staying up whether or not your own machine is even turned
on. Screens can open `https://your-domain.com/player.html` from anywhere
too, no VPN or same-network requirement.

**Updating later**: see "Automatic deploys on every push" below — same
idea applies to any VPS, not just Oracle specifically.

## Automatic deploys on every push

This makes any VPS (Oracle, a generic VPS, anywhere you've cloned this
repo and set it up with pm2) behave like Railway or Render — push to
GitHub, and the live site updates itself within a minute or two, no
manual SSH session required each time.

**How it works**: a GitHub Actions workflow (`.github/workflows/deploy.yml`,
already in this repo) runs on every push to your main branch. It SSHes
into your VPS using a dedicated key and runs `deploy/update.sh`, which
pulls the latest code, reinstalls dependencies, and restarts the app
with pm2.

**1. Generate a dedicated deploy key** (on your own Mac, not the VPS —
this key's only job is letting GitHub's servers log into your VPS):
```
ssh-keygen -t ed25519 -f ~/.ssh/vps_deploy_key -C "github-actions-deploy" -N ""
```
The `-N ""` skips setting a passphrase — required here, since GitHub
Actions runs unattended and can't be prompted for one.

**2. Add the public half to your VPS's authorized keys — restricted to
only running the deploy script, not full shell access**

This is the important part, security-wise: rather than granting this key
the same unrestricted access a normal login would have, we tell SSH to
ignore whatever command it's asked to run and *always* run the update
script instead, no matter what. If this key ever leaked, the most it
could ever do is trigger a redeploy — not open a shell, read your files,
or do anything else.
```
cat ~/.ssh/vps_deploy_key.pub
```
Copy that output. Then, connected to your VPS via SSH as usual, run this
— replacing `YOUR_PROJECT_FOLDER` with your actual folder name, and
`PASTE_THE_PUBLIC_KEY_HERE` with what you just copied:
```
echo 'command="cd ~/YOUR_PROJECT_FOLDER && bash deploy/update.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty PASTE_THE_PUBLIC_KEY_HERE' >> ~/.ssh/authorized_keys
```
(If you'd rather see it broken apart first before running the combined
command: the `command="..."` part forces every connection using this
specific key to only ever run `cd ~/YOUR_PROJECT_FOLDER && bash
deploy/update.sh`, ignoring anything else requested; the `no-*` flags
switch off port forwarding, X11 forwarding, agent forwarding, and
interactive terminal allocation — none of which a deploy script needs,
so there's no reason this key should be able to do them.)

**3. Add the private half, plus your connection details, as GitHub secrets**

On your repo's GitHub page: **Settings** → **Secrets and variables** →
**Actions** → **New repository secret**. Add each of these:

| Secret name | Value |
|---|---|
| `VPS_HOST` | Your VPS's IP or hostname |
| `VPS_PORT` | Your SSH port (often `22`, sometimes custom) |
| `VPS_USERNAME` | Your SSH username (often `root`) |
| `VPS_SSH_KEY` | The full contents of `~/.ssh/vps_deploy_key` (the **private** key — run `cat ~/.ssh/vps_deploy_key` on your Mac and paste the whole thing, including the `-----BEGIN...-----` and `-----END...-----` lines) |
| `VPS_PROJECT_FOLDER` | The folder name your project lives in on the VPS (e.g. `your-repo-name`) |

**4. Push to trigger it**
```
git push
```
On your repo's GitHub page, click the **Actions** tab to watch it run
live — green check means it pulled and restarted successfully. From now
on, every push to your main branch updates the live site automatically.

**Testing it without waiting for a real change**: GitHub's Actions tab
has a **Run workflow** button for manually triggering it on demand, handy
for confirming the setup works before you're relying on it.

**If it fails**, click into the failed run in the Actions tab — the log
shows exactly which step broke (a wrong secret value, a key that wasn't
added to `authorized_keys` correctly, or the project folder name not
matching are the most common causes).

**Requiring approval before a deploy runs (optional, recommended)**

As set up so far, every push to `main` deploys immediately and
automatically — no review step, no "are you sure?" That's exactly what
"push to deploy" means, but it also means a mistaken push (a
work-in-progress commit, an accidental `git add .`, a collaborator's
unreviewed change) goes live on your actual screens within a minute,
with nothing standing in the way. If you'd rather have a pause-and-approve
step first, this workflow already has the hook for it
(`environment: production` in `deploy.yml`) — you just need to turn on
the requirement in GitHub, which the workflow file alone can't do:

1. On your repo's GitHub page: **Settings** → **Environments** → **New environment**
2. Name it exactly `production` (must match the `environment:` line in `deploy.yml`)
3. Under **Deployment protection rules**, enable **Required reviewers** and add yourself (or anyone else who should approve deploys)
4. Save

From then on, every push still triggers the workflow, but it pauses
before actually connecting to your VPS — you (or whoever you added) gets
a notification and has to click **Approve** in the Actions tab before
the deploy proceeds. Skip this whole section if instant-on-push is
genuinely what you want; the workflow works identically either way,
this just adds a gate in front of it.

**What happens on each screen after a deploy**: restarting the server
doesn't push anything to browser tabs that already have a page loaded —
they keep running whatever code they loaded originally until something
makes them reload. That's fine for the admin dashboard (you're sitting
right there to refresh it), but not for an unattended screen with no
keyboard. So the player specifically checks every 60 seconds whether the
server has restarted since it loaded, and reloads itself automatically
if so — no one needs to touch the screen for it to pick up a deploy. The
admin dashboard doesn't do this (an unexpected reload mid-edit would be
more disruptive than helpful there) — just refresh it by hand after a
deploy if you're actively using it at the time.

**What this setup still trusts, even with the key restricted** — worth
knowing rather than assuming it's airtight: anyone with write access to
this GitHub repo could edit the workflow file itself to do something
different (since the workflow is what actually uses the secret), so repo
write-access is effectively equivalent to deploy-key access, transitively.
For a solo project that's a non-issue; if you ever add collaborators,
it's worth knowing. This setup also relies on a third-party GitHub Action
(`appleboy/ssh-action`) to make the SSH connection — it's a long-standing,
widely-used one, and pinned here to a fixed version rather than a
moving tag, but using any third-party Action means trusting its
maintainer's supply chain to some degree, the same as installing any
npm package.

## How live updates work

Screens and the dashboard each open a connection to `/api/events` (Server-
Sent Events). Whenever content, a playlist, or a screen's assignment
changes, the server pushes a small notification and the relevant page
refetches — so assigning a new playlist to a screen updates it within a
couple of seconds, no reload needed. Screens also call in every 25 seconds
so the dashboard can show accurate online/offline status.

## Notes

- **Slide duration defaults**: when you add a video or audio file to a
  playlist, its slide duration is automatically set to that file's actual
  length (detected in your browser at upload time and stored alongside
  it) — not a generic fallback. You can still override it afterward via
  the slide's edit (pencil) icon. Images have no inherent duration, so
  they still use the manual "Duration (seconds)" field in the picker
  (defaults to 10s).
- **Audio slides**: upload an audio file (mp3, wav, etc.) to the content
  library just like an image or video, then add it to a playlist the same
  way. It plays while its slide is showing, alongside its title/body text
  and a small icon in place of a picture.
- **Video with its own sound**: video slides are silent loops by default
  (so background footage doesn't unexpectedly blast audio). To let a
  specific video's baked-in audio actually play, open that slide's edit
  (pencil) icon and check "Play this video's own audio."
- **Voiceover over an image or video**: open an image or video slide's
  edit (pencil) icon and pick an audio file under "Voiceover" — it plays
  alongside that slide, independent of the slide's own audio. A slide
  can have a video's own audio *or* a voiceover, not both at once (the
  editor keeps these mutually exclusive so they don't overlap).
- **Sound requires launching the browser correctly.** There is no
  "tap to enable sound" prompt — playback with audio is expected to work
  automatically. That only actually works if the browser itself is
  launched with autoplay restrictions disabled; otherwise browsers block
  audio/video-with-sound from autoplaying and it will silently not play,
  with nothing on screen indicating why. For Chrome:
  ```
  chrome --kiosk --autoplay-policy=no-user-gesture-required "http://your-url/player.html"
  ```
  Set this up once per screen and sound will "just work" from then on.
- **Player resilience**: each screen caches its current playlist, ticker,
  and slide position in the browser's local storage every time it
  successfully syncs. If the server becomes unreachable (Wi-Fi drop,
  Cloudflare Tunnel machine restarting, etc.), the screen keeps playing
  its last-known content and shows a small "Reconnecting…" badge, rather
  than going blank or forgetting its pairing. It reconciles with live data
  automatically once the connection returns. A screen only ever re-asks
  for a pairing code if it's actually removed from the dashboard.
- Uploads are capped at 500MB per file (adjustable in `server/server.js`,
  search for `fileSize`).
- Deleting content removes both its database row and its file in R2;
  playlists that used it simply skip that slide.
- This server is meant for use on a trusted network or behind your own
  authentication/reverse proxy — the login only protects the dashboard's
  write actions; screen read endpoints are intentionally open so paired
  displays don't need credentials. If deploying publicly (see "Deploying
  to Oracle Cloud"), login attempts and pairing-code attempts are rate
  limited (15 per 15 minutes per IP) to make guessing impractical, and
  session cookies are marked HTTPS-only automatically when `NODE_ENV=production`
  (set by `ecosystem.config.js` in the deploy flow).
- The server creates its tables automatically, but not the database itself.
  The `docker-compose.yml` setup creates the database for you (via
  `POSTGRES_DB`); if you're using a local install or cloud host instead,
  make sure the database named in `DB_NAME` already exists before first run.
- To back up your data: a Postgres dump of your database (e.g.
  `pg_dump -U postgres signal_signage > backup.sql`) — the actual uploaded
  files live in R2 and don't need separate local backup, though R2 itself
  supports bucket-level backup/versioning if you want extra safety there.
