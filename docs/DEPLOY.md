# Production deploy (rps-battles.com)

**Deploy инициируется GitHub Actions при любом пуше в ветку `main`.**

Твоя локальная машина **не участвует** в деплое. Она только делает `git push`.  
Весь деплой выполняется на инфраструктуре GitHub (runner `ubuntu-latest`), который подключается по SSH на прод-сервер, используя ключ, хранящийся в секретах репозитория.

## Как это работает

```
Любой пуш в main          GitHub
(с любого компьютера,          │
 из веб-интерфейса, PR и т.д.) │
                               ▼
                    GitHub Actions (runner на GitHub)
                               │
                    appleboy/ssh-action
                    (берёт ключ из GitHub Secrets)
                               │
                               ▼
                    Прод-сервер (root@178.104.89.151)
                               │
                    /root/www/scripts/deploy.sh
```

- Workflow: `.github/workflows/deploy.yml`
- Триггер: `push` на `main` / `master` + ручной запуск (`workflow_dispatch`)
- GitHub runner делает `git fetch + reset` и перезапускает сервис на сервере.

## Разовая настройка (один раз на всё)

Нужно создать 3 секрета в настройках репозитория GitHub.  
После этого **никаких ключей на локальной машине** для деплоя не требуется.

### 1. Сгенерируй пару ключей (на любом компьютере / в любом терминале)

Можешь сделать это где угодно — хоть на своём ноуте, хоть в GitHub Codespace, хоть в /tmp на сервере (потом удали).

```bash
ssh-keygen -t ed25519 -f ./rps-gh-actions-deploy -C "rps-gh-actions" -N ""
```

У тебя появятся два файла:
- `rps-gh-actions-deploy`     ← **приватный ключ** (нужен только один раз)
- `rps-gh-actions-deploy.pub` ← публичный ключ

### 2. Добавь публичный ключ на сервер (если генерировал новый)

```bash
cat ./rps-gh-actions-deploy.pub
```

Скопируй вывод и добавь на сервер (через обычный SSH):

```bash
echo 'ssh-ed25519 AAAA...сюда_весь_вывод_из_.pub...' >> ~/.ssh/authorized_keys
```

> На сервере уже лежит один такой ключ. Если у тебя сохранился старый приватный ключ, который ему соответствует — можно использовать его.

### 3. Добавь секреты через веб-интерфейс GitHub (рекомендуется)

Перейди по ссылке:
https://github.com/soufee/rps-battle/settings/secrets/actions

Нажми **"New repository secret"** три раза и создай:

| Name              | Secret value                                      |
|-------------------|---------------------------------------------------|
| `DEPLOY_HOST`     | `178.104.89.151`                                  |
| `DEPLOY_USER`     | `root`                                            |
| `DEPLOY_SSH_KEY`  | **полное содержимое файла** `rps-gh-actions-deploy` (приватный ключ, включая строки BEGIN/END) |

Скопируй-вставь содержимое приватного ключа целиком.

### 4. (Опционально) Удали локальные файлы ключа

После того, как приватный ключ вставлен в секрет GitHub, файл `rps-gh-actions-deploy` на твоей машине можно удалить. Он больше не нужен для обычных деплоев.

## Как теперь работает деплой

Просто пушь в main **откуда угодно**:

```bash
git push origin main
```

Или через веб: Edit file → Commit directly to main.

GitHub сам запустит workflow "Deploy production" и сделает деплой.

Можешь также запускать вручную:
Actions → Deploy production → Run workflow.

## Что делает скрипт деплоя

1. `git fetch` + `git reset --hard origin/main`
2. Backend: npm install + prisma migrate
3. Client: npm install + build
4. `systemctl restart rps-v2-backend`
5. Health-check

Секреты приложения (`backend/.env`) и данные БД/Redis остаются на сервере.

## Ручной деплой (на всякий случай)

```bash
ssh root@178.104.89.151
/root/www/scripts/deploy.sh
```

## Итог

- Таймер на сервере удалён.
- Деплой только через GitHub Actions.
- После одной настройки секретов в веб-интерфейсе GitHub — пуш в main из любого места = автоматический деплой.

Если после добавления секретов ран всё равно падает с "missing server host" — пришли сюда ссылку на ран, посмотрим.
