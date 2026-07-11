# Production deploy (rps-battles.com)

## Flow

1. Develop locally on any branch.
2. Merge / push to **`main`** on GitHub (`soufee/rps-battle`).
3. GitHub Actions (`Deploy production`) SSHs into the Hetzner host and runs `scripts/deploy.sh`.
4. Fallback: systemd timer on the server polls `origin/main` every minute and deploys if needed.

## Required GitHub secrets

| Secret | Value |
|--------|--------|
| `DEPLOY_HOST` | `178.104.89.151` |
| `DEPLOY_USER` | `root` |
| `DEPLOY_SSH_KEY` | private key of the deploy user (see server `~/.ssh/github_actions_deploy`) |

## Manual deploy on the server

```bash
ssh -i ~/.ssh/hetzner root@178.104.89.151
/root/www/scripts/deploy.sh
```

## What stays on the server

- Running product: Node backend (systemd `rps-v2-backend`), MySQL + Redis (Docker), nginx, TLS
- App tree at `/root/www` (git checkout used only for deploy/build)
- Secrets: `/root/www/backend/.env` (never in git)
- DB/redis data: `/root/www/data/`

## What is not for development on the server

Develop on your laptop. Do not leave agent caches, experimental clients, or one-off scripts on the host.
