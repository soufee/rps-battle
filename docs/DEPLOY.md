# Production deploy (rps-battles.com)

Deploy happens **automatically on every push to `main`** via GitHub Actions.

## How it works

```
local laptop ── git push origin main ──▶ GitHub
                                          │
                                          ▼
                              GitHub Actions (ubuntu-latest)
                                          │
                              appleboy/ssh-action (using secrets)
                                          │
                                          ▼
                              server (root@178.104.89.151)
                                          │
                              /root/www/scripts/deploy.sh
```

- The workflow file is `.github/workflows/deploy.yml`
- It triggers on `push` to `main` (and `master`) + supports manual `workflow_dispatch`.
- Concurrency group prevents overlapping deploys.
- The script on the server has a lock file (`/tmp/rps-deploy.lock`).

## One-time setup: GitHub repository secrets

You need three secrets in the GitHub repo `soufee/rps-battle`:

| Secret            | Value                              |
|-------------------|------------------------------------|
| `DEPLOY_HOST`     | `178.104.89.151`                   |
| `DEPLOY_USER`     | `root`                             |
| `DEPLOY_SSH_KEY`  | full content of private key file   |

### Step-by-step (on your laptop)

1. Make sure you have GitHub CLI and are logged in:
   ```bash
   gh auth login
   ```

2. **Generate a dedicated SSH key** (if you don't already have `~/.ssh/rps_github_actions_deploy`):

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/rps_github_actions_deploy -C "github-actions-rps-deploy" -N ""
   ```

   This creates:
   - `~/.ssh/rps_github_actions_deploy` (private — never commit!)
   - `~/.ssh/rps_github_actions_deploy.pub` (public)

3. **Add the public key to the server** (only needed if you generated a new key):

   ```bash
   # Copy the public key content and append on the server
   cat ~/.ssh/rps_github_actions_deploy.pub
   # Then on server (via your normal ssh):
   # echo 'ssh-ed25519 AAAA... github-actions-rps-deploy' >> ~/.ssh/authorized_keys
   ```

   (The original key with this comment is already present on the server. If you reuse an existing private key that matches the authorized one, you can skip this.)

4. **Set the secrets** (run from the repo directory on your laptop):

   ```bash
   cd /path/to/rps-battle

   gh secret set DEPLOY_HOST -b'178.104.89.151' -R soufee/rps-battle
   gh secret set DEPLOY_USER -b'root' -R soufee/rps-battle
   gh secret set DEPLOY_SSH_KEY -R soufee/rps-battle < ~/.ssh/rps_github_actions_deploy
   ```

   Or use the GitHub web UI:
   - Repo → Settings → Secrets and variables → Actions → New repository secret

## Daily workflow

```bash
# on your laptop
git add -A
git commit -m "your message"
git push origin main
```

- Go to https://github.com/soufee/rps-battle/actions
- Watch the "Deploy production" workflow.
- After it finishes successfully, check https://rps-battles.com/api/v2/health

You can also trigger a deploy manually:
- Actions tab → "Deploy production" → "Run workflow" → Run.

## What the deploy script does

1. `git fetch` + hard reset to `origin/main`
2. Backend: `npm install`, `prisma generate`, `prisma migrate deploy`
3. Client: `npm install`, `npm run build` (web export → `client/dist`)
4. `systemctl restart rps-v2-backend`
5. Health check on `http://127.0.0.1:3001/api/v2/health`

Production-only files that are never in git:
- `backend/.env`
- `data/mysql/`, `data/redis/`

## Manual / emergency deploy

If you need to run deploy directly:

```bash
# from your laptop
ssh -i ~/.ssh/rps_github_actions_deploy root@178.104.89.151
# or using your regular key:
ssh root@178.104.89.151

# then on server
/root/www/scripts/deploy.sh
```

## Server layout

| Path                    | Role |
|-------------------------|------|
| `/root/www`             | App checkout |
| `/root/www/backend`     | Node API + Socket.IO (`rps-v2-backend.service`) |
| `/root/www/client/dist` | Built web UI |
| `/root/www/backend/.env`| Secrets (not in git) |
| `/root/www/data`        | MySQL + Redis data |
| nginx                   | TLS → backend on :3001 |

Develop on your laptop. The server is only for production runtime.

