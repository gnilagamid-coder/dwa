#!/usr/bin/env bash
# Обновляет код сразу для всех магазинов на сервере.
# Код общий (/opt/tg-shop-code), данные у каждого свои — поэтому обновление
# это один rsync и перезапуск сервисов. Данные и .env не трогаются.
#
#   bash update-all.sh
set -euo pipefail

BASE_DIR="/opt/shops"
CODE_DIR="/opt/tg-shop-code"

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mX  %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Запусти от root:  sudo bash update-all.sh"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -d "$CODE_DIR" ] || die "$CODE_DIR не найден — сначала добавь магазин через add-shop.sh"

SHOPS=()
for d in "$BASE_DIR"/*/; do [ -f "${d}.env" ] && SHOPS+=("$(basename "$d")"); done
[ ${#SHOPS[@]} -gt 0 ] || die "В $BASE_DIR нет ни одного магазина"
say "Магазинов найдено: ${#SHOPS[@]} — ${SHOPS[*]}"

if [ -d "$SRC_DIR/.git" ]; then
  say "Забираю обновления из git"
  git -C "$SRC_DIR" fetch --all --quiet
  BRANCH="$(git -C "$SRC_DIR" rev-parse --abbrev-ref HEAD)"
  if ! git -C "$SRC_DIR" diff --quiet || ! git -C "$SRC_DIR" diff --cached --quiet; then
    warn "Есть незакоммиченные правки — прячу в stash"
    git -C "$SRC_DIR" stash push -u -m "update-all.sh $(date +%F_%T)" >/dev/null
  fi
  git -C "$SRC_DIR" pull --ff-only origin "$BRANCH"
  echo "   коммит: $(git -C "$SRC_DIR" rev-parse --short HEAD)"
fi

say "Резервные копии данных"
STAMP="$(date +%F-%H%M)"
for s in "${SHOPS[@]}"; do
  tar czf "/root/${s}-backup-${STAMP}.tgz" -C "${BASE_DIR}/${s}" data
  echo "   /root/${s}-backup-${STAMP}.tgz"
done

say "Обновляю общий код"
rsync -a --delete \
  --exclude 'data' --exclude '.env' --exclude '.git' --exclude 'node_modules' \
  "$SRC_DIR"/ "$CODE_DIR"/
chown -R tgshop:tgshop "$CODE_DIR"

say "Перезапускаю магазины"
FAILED=()
for s in "${SHOPS[@]}"; do
  systemctl restart "tg-shop@${s}"
  sleep 1
  if systemctl is-active --quiet "tg-shop@${s}"; then
    echo "   ✓ ${s}"
  else
    echo "   ✗ ${s}"
    FAILED+=("$s")
  fi
done

if [ ${#FAILED[@]} -gt 0 ]; then
  warn "Не поднялись: ${FAILED[*]}"
  for s in "${FAILED[@]}"; do journalctl -u "tg-shop@${s}" -n 20 --no-pager; done
  die "Откат данных: tar xzf /root/<магазин>-backup-${STAMP}.tgz -C ${BASE_DIR}/<магазин>"
fi

say "Проверяю связь с Telegram"
curl -sS -m 10 -o /dev/null https://api.telegram.org \
  && echo "   api.telegram.org отвечает" \
  || warn "api.telegram.org недоступен — боты работать не будут"

echo
echo "Готово. Обновлено магазинов: ${#SHOPS[@]}. Бэкапы в /root/*-backup-${STAMP}.tgz"
