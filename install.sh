#!/usr/bin/env bash
# Установщик магазина на чистый Debian 11/12 или Ubuntu 22.04/24.04.
# Запускать от root:  bash install.sh
set -euo pipefail

APP_DIR="/opt/tg-shop"
SERVICE="tg-shop"
NODE_MAJOR=20

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mX  %s\033[0m\n' "$*" >&2; exit 1; }
ask()  { local p="$1" d="${2:-}" a; read -rp "$p${d:+ [$d]}: " a; echo "${a:-$d}"; }

[ "$(id -u)" = "0" ] || die "Запусти от root:  sudo bash install.sh"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say "Обновляю пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync >/dev/null

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  say "Ставлю Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
say "Node $(node -v)"

# ---------- параметры ----------
echo
echo "──────────── Настройка ────────────"
BOT_TOKEN="$(ask 'Токен бота от @BotFather')"
[ -n "$BOT_TOKEN" ] || die "Без токена бот и уведомления работать не будут"
DOMAIN="$(ask 'Домен (например shop.example.com), пусто = только по IP')"
ADMIN_TOKEN="$(ask 'Пароль в админку (Enter — сгенерирую)')"
[ -n "$ADMIN_TOKEN" ] || ADMIN_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
PORT="$(ask 'Внутренний порт' '3000')"

# ---------- файлы ----------
say "Копирую в ${APP_DIR}"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude 'data' --exclude '.env' --exclude '.git' --exclude 'node_modules' \
  "$SRC_DIR"/ "$APP_DIR"/
mkdir -p "$APP_DIR/data/images"

id -u tgshop >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin tgshop
chown -R tgshop:tgshop "$APP_DIR"

PUBLIC_URL="http://$(hostname -I | awk '{print $1}'):${PORT}"
[ -n "$DOMAIN" ] && PUBLIC_URL="https://${DOMAIN}"

cat > "$APP_DIR/.env" <<EOF
BOT_TOKEN=${BOT_TOKEN}
ADMIN_TOKEN=${ADMIN_TOKEN}
PORT=${PORT}
HOST=127.0.0.1
PUBLIC_URL=${PUBLIC_URL}
DATA_DIR=${APP_DIR}/data
EOF
chown tgshop:tgshop "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# ---------- systemd ----------
say "Ставлю сервис systemd"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Telegram Mini App Shop
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tgshop
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node ${APP_DIR}/server/index.js
Restart=always
RestartSec=3
# базовая изоляция: сервису доступна на запись только своя папка data
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/data

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE" >/dev/null
sleep 2
systemctl is-active --quiet "$SERVICE" || { journalctl -u "$SERVICE" -n 30 --no-pager; die "Сервис не поднялся"; }

# ---------- nginx + TLS ----------
if [ -n "$DOMAIN" ]; then
  say "Настраиваю nginx для ${DOMAIN}"
  apt-get install -y -qq nginx >/dev/null
  cat > "/etc/nginx/sites-available/${SERVICE}" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    # админка отдаёт токен в заголовке, а картинки могут быть тяжёлыми
    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  ln -sf "/etc/nginx/sites-available/${SERVICE}" "/etc/nginx/sites-enabled/${SERVICE}"
  rm -f /etc/nginx/sites-enabled/default
  nginx -t >/dev/null && systemctl reload nginx

  say "Выпускаю сертификат Let's Encrypt"
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect >/dev/null 2>&1; then
    echo "   сертификат выпущен"
  else
    warn "Certbot не смог выпустить сертификат. Проверь, что A-запись ${DOMAIN} указывает на этот сервер, и повтори:"
    warn "   certbot --nginx -d ${DOMAIN}"
  fi

  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 'Nginx Full' >/dev/null || true
  fi
fi

# ---------- итог ----------
cat <<EOF

════════════════════════════════════════════════
  Готово.

  Витрина:  ${PUBLIC_URL}/
  Админка:  ${PUBLIC_URL}/admin.html
  Пароль:   ${ADMIN_TOKEN}

  Осталось в @BotFather:
    /newapp  →  выбрать бота  →  URL: ${PUBLIC_URL}/
    /setmenubutton → ссылка на мини-апп

  Управление:
    systemctl status ${SERVICE}
    systemctl restart ${SERVICE}
    journalctl -u ${SERVICE} -f
  Бэкап:  tar czf backup.tgz -C ${APP_DIR} data
════════════════════════════════════════════════
EOF
