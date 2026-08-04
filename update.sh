#!/usr/bin/env bash
# Обновление уже установленного магазина: забирает свежий код и перезапускает
# сервис. Ничего не спрашивает и НЕ ТРОГАЕТ ни .env, ни data/ — токены, пароль
# админки, товары и фотографии остаются на месте.
#
#   bash update.sh
set -euo pipefail

APP_DIR="/opt/tg-shop"
SERVICE="tg-shop"

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mX  %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Запусти от root:  sudo bash update.sh"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -d "$APP_DIR" ] || die "Магазин не установлен ($APP_DIR не найден). Нужен install.sh, а не update.sh"
[ -f "$APP_DIR/.env" ] || die "Нет $APP_DIR/.env — установка неполная, запусти install.sh"

# ---------- забираем свежий код ----------
if [ -d "$SRC_DIR/.git" ]; then
  say "Забираю обновления из git"
  git -C "$SRC_DIR" fetch --all --quiet
  BRANCH="$(git -C "$SRC_DIR" rev-parse --abbrev-ref HEAD)"
  # локальные правки не даём потерять молча
  if ! git -C "$SRC_DIR" diff --quiet || ! git -C "$SRC_DIR" diff --cached --quiet; then
    warn "В $SRC_DIR есть незакоммиченные изменения — они будут сохранены в stash"
    git -C "$SRC_DIR" stash push -u -m "update.sh $(date +%F_%T)" >/dev/null
  fi
  git -C "$SRC_DIR" pull --ff-only origin "$BRANCH"
  echo "   ветка: $BRANCH, коммит: $(git -C "$SRC_DIR" rev-parse --short HEAD)"
else
  warn "$SRC_DIR — не git-репозиторий. Обновляю из того, что лежит в папке."
fi

# ---------- бэкап данных перед обновлением ----------
say "Делаю резервную копию данных"
BACKUP="/root/tg-shop-backup-$(date +%F-%H%M).tgz"
tar czf "$BACKUP" -C "$APP_DIR" data
echo "   $BACKUP"

# ---------- раскладываем код ----------
say "Обновляю файлы в $APP_DIR"
rsync -a --delete \
  --exclude 'data' --exclude '.env' --exclude '.git' --exclude 'node_modules' \
  "$SRC_DIR"/ "$APP_DIR"/
chown -R tgshop:tgshop "$APP_DIR"
chmod 600 "$APP_DIR/.env"

# ---------- перезапуск ----------
say "Перезапускаю сервис"
systemctl restart "$SERVICE"
sleep 2

if ! systemctl is-active --quiet "$SERVICE"; then
  warn "Сервис не поднялся. Последние строки лога:"
  journalctl -u "$SERVICE" -n 25 --no-pager
  die "Откат: tar xzf $BACKUP -C $APP_DIR && systemctl restart $SERVICE"
fi

# ---------- проверка связи с Telegram ----------
say "Проверяю связь с Telegram"
if curl -sS -m 10 -o /dev/null https://api.telegram.org; then
  echo "   api.telegram.org отвечает"
else
  warn "api.telegram.org недоступен с этого сервера — бот работать не будет."
  warn "Проверь: curl -sS -m 10 https://api.telegram.org"
fi

echo
journalctl -u "$SERVICE" -n 8 --no-pager | sed 's/^/   /'
cat <<EOF

════════════════════════════════════════════════
  Обновлено. Сервис запущен.

  Бэкап данных: ${BACKUP}
  Логи:         journalctl -u ${SERVICE} -f

  В браузере обновите страницу с очисткой кэша:
  Ctrl+F5 (Windows) или Cmd+Shift+R (Mac)
════════════════════════════════════════════════
EOF
