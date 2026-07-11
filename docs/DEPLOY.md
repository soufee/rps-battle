# Production deploy (rps-battles.com)

## How it works

```
local laptop  →  git push origin main  →  GitHub
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     ▼                                             ▼
          GitHub Actions (optional)                    Server timer (always on)
          SSH → scripts/deploy.sh                      every 1 min: fetch main
                                                       if new → scripts/deploy.sh
```

**Active now:** the Hetzner host polls `origin/main` every minute (`rps-auto-deploy.timer`) and runs the deploy script when the branch moves. You can develop locally, push to `main`, and the site updates within ~1–3 minutes (plus build time).

**Optional:** GitHub Actions workflow `.github/workflows/deploy.yml` can deploy immediately on push once secrets are set (see below).

## Daily workflow

```bash
cd /path/to/rps-battle
# ... develop ...
git add -A && git commit -m "your message"
git push origin main
# wait for deploy; check https://rps-battles.com/api/v2/health
```

Default branch is **`main`** (not `master`). The workflow also listens for `master` if you rename later.

## What deploy does

1. `git fetch` + hard reset to `origin/main`
2. Backend: `npm install`, `prisma generate`, `prisma migrate deploy`
3. Client: `npm install`, `npm run build` (web export → `client/dist`)
4. `systemctl restart rps-v2-backend`
5. Health check on `http://127.0.0.1:3001/api/v2/health`

Preserved on the server (never in git): `backend/.env`, `data/mysql`, `data/redis`.

## Enable GitHub Actions deploy (optional)

On your laptop (with [GitHub CLI](https://cli.github.com/) logged in):

```bash
gh auth login
cd /path/to/rps-battle
gh secret set DEPLOY_HOST -b'178.104.89.151'
gh secret set DEPLOY_USER -b'root'
gh secret set DEPLOY_SSH_KEY < ~/.ssh/rps_github_actions_deploy
```

The matching public key is already in `/root/.ssh/authorized_keys` on the server.

## Manual deploy

```bash
ssh -i ~/.ssh/hetzner root@178.104.89.151
/root/www/scripts/deploy.sh
```

## Server layout (production only)

| Path | Role |
|------|------|
| `/root/www` | App checkout (deploy/build) |
| `/root/www/backend` | Node API + Socket.IO (`rps-v2-backend.service`) |
| `/root/www/client/dist` | Built web UI served by backend |
| `/root/www/shared` | Shared game rules (runtime import) |
| `/root/www/data` | MySQL + Redis volumes |
| `/root/www/backend/.env` | Secrets |
| nginx | TLS for `rps-battles.com` → `:3001` |
| docker | `rps_mysql_v2`, `rps_redis_v2` |

Develop on the laptop, not on the server.
