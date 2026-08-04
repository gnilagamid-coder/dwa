#!/usr/bin/env bash
# update-all.sh — параллельное обновление всех магазинов (ботов-мини-аппов) на сервере.
#
# Архитектура: код общий (/opt/tg-shop-code — один git pull и один rsync на всех),
# каждый магазин — отдельная папка /opt/shops/<имя> со своим .env и data/ и своим
# systemd-сервисом tg-shop@<имя>. Магазины изолированы: падение или обновление
# одного не трогает соседей, поэтому рестарты выполняются параллельно.
#
# Использование:
#   bash update-all.sh                  # все магазины, 4 параллельных потока
#   bash update-all.sh -j 6             # 6 потоков (то же, что UPDATE_JOBS=6; потолок 8)
#   bash update-all.sh vinty merch      # обновить только перечисленные магазины
#   UPDATE_BRANCH=main bash update-all.sh   # тянуть код из конкретной ветки
#
# Список магазинов берётся из bots.conf рядом со скриптом (одно имя на строку,
# '#' — комментарий, строка branch=<имя> задаёт ветку git). Если bots.conf нет —
# обновляются все магазины из /opt/shops, у которых есть .env.
#
# Лог каждого магазина: /var/log/tg-shop-update/<имя>.log
# Ошибка одного магазина не останавливает остальные; в конце печатается сводка.
# Данные (.env, data/) не трогаются; перед рестартом каждого магазина снимается
# бэкап его data/ в /root/.

set -uo pipefail   # -e намеренно нет: ошибка одного магазина не должна убивать общий прогон

BASE_DIR="/opt/shops"
CODE_DIR="/opt/tg-shop-code"
LOG_DIR="${LOG_DIR:-/var/log/tg-shop-update}"
STAMP="$(date +%F-%H%M)"
UNIT_TEMPLATE="/etc/systemd/system/tg-shop@.service"

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mX  %s\033[0m\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
update-all.sh — параллельное обновление всех магазинов на сервере

  bash update-all.sh                 все магазины, 4 потока
  bash update-all.sh -j 6            число параллельных потоков (1..8)
  UPDATE_JOBS=6 bash update-all.sh   то же через переменную окружения
  bash update-all.sh vinty merch     только перечисленные магазины
  UPDATE_BRANCH=main bash update-all.sh   тянуть код из конкретной ветки

Список магазинов: bots.conf рядом со скриптом (одно имя на строку, '#' —
комментарий, branch=<имя> задаёт ветку git). Без bots.conf берутся все
магазины из /opt/shops, у которых есть .env.

Логи: /var/log/tg-shop-update/<имя>.log, в конце — сводка по всем.
EOF
  exit 0
}

# ---------- аргументы ----------
JOBS="${UPDATE_JOBS:-4}"
FILTER=()
while [ $# -gt 0 ]; do
  case "$1" in
    -j|--jobs) [ $# -ge 2 ] || die "-j/--jobs требует число"; JOBS="$2"; shift 2 ;;
    -h|--help) usage ;;
    --) shift; while [ $# -gt 0 ]; do FILTER+=("$1"); shift; done ;;
    -*) die "Неизвестная опция: $1  (справка: -h)" ;;
    *) FILTER+=("$1"); shift ;;
  esac
done
[[ "$JOBS" =~ ^[0-9]+$ ]] && [ "$JOBS" -ge 1 ] || die "-j/--jobs: нужно целое число >= 1"
if [ "$JOBS" -gt 8 ]; then warn "Ограничиваю параллельные потоки до 8 (запрошено $JOBS)"; JOBS=8; fi

# ---------- предварительные проверки ----------
[ "$(id -u)" = "0" ] || die "Запусти от root:  sudo bash update-all.sh"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -d "$CODE_DIR" ] || die "$CODE_DIR не найден — сначала добавь магазин через add-shop.sh"
[ -f "$UNIT_TEMPLATE" ] || die "Нет шаблона $UNIT_TEMPLATE — сначала add-shop.sh"
id -u tgshop >/dev/null 2>&1 || die "Нет системного пользователя tgshop — установка неполная"
command -v rsync >/dev/null 2>&1 || die "Нет rsync: apt install -y rsync"

# ---------- список магазинов ----------
CONF="$SRC_DIR/bots.conf"
CONF_BRANCH=""
CANDIDATES=()
if [ -f "$CONF" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d ' \t\r')"
    [ -z "$line" ] && continue
    if [[ "$line" == branch=* ]]; then CONF_BRANCH="${line#branch=}"; continue; fi
    CANDIDATES+=("$line")
  done < "$CONF"
  say "Список магазинов взят из bots.conf (ветка git: ${CONF_BRANCH:-текущая})"
else
  for d in "$BASE_DIR"/*/; do [ -f "${d}.env" ] && CANDIDATES+=("$(basename "$d")"); done
  say "bots.conf не найден — беру все магазины из $BASE_DIR"
fi
[ ${#CANDIDATES[@]} -gt 0 ] || die "Список магазинов пуст"

SHOPS=(); MISSING=()
for s in "${CANDIDATES[@]}"; do
  if [ ${#FILTER[@]} -gt 0 ]; then
    keep=0; for f in "${FILTER[@]}"; do [ "$f" = "$s" ] && keep=1; done
    [ "$keep" = 1 ] || continue
  fi
  if [ -f "$BASE_DIR/$s/.env" ]; then SHOPS+=("$s"); else MISSING+=("$s"); fi
done
for f in "${FILTER[@]}"; do
  found=0; for s in "${SHOPS[@]}"; do [ "$s" = "$f" ] && found=1; done
  [ "$found" = 1 ] || MISSING+=("$f")
done
[ ${#SHOPS[@]} -gt 0 ] || die "Ни одного существующего магазина не найдено"
for m in "${MISSING[@]}"; do warn "Магазин '$m' из списка не найден в $BASE_DIR (нет .env) — пропускаю"; done
say "Магазинов к обновлению: ${#SHOPS[@]} — ${SHOPS[*]}"

# ---------- прикидка ресурсов VPS ----------
MEM_MB="$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)"
CORES="$(nproc)"
NEED_MB=$(( ${#SHOPS[@]} * 55 + 300 ))   # ~50 МБ на экземпляр node + запас системе
say "Ресурсы VPS: ${MEM_MB} МБ RAM, ${CORES} ядер; магазинов: ${#SHOPS[@]}, потоков: ${JOBS}"
if [ "$MEM_MB" -lt "$NEED_MB" ]; then
  warn "RAM впритык: магазин ест ~45-50 МБ, на ${#SHOPS[@]} штук желательно >= ${NEED_MB} МБ."
  warn "Подробнее про лимиты — в README, раздел «Лимиты VPS»."
fi
NOFILE="$(ulimit -n)"
if [ "$NOFILE" -lt 1024 ]; then
  warn "Низкий лимит открытых файлов (ulimit -n=$NOFILE) — подними: ulimit -n 65536"
fi

# ---------- git: общий репозиторий, один раз на всех ----------
BRANCH="${UPDATE_BRANCH:-$CONF_BRANCH}"
if [ -d "$SRC_DIR/.git" ]; then
  say "Забираю обновления из git${BRANCH:+ (ветка: $BRANCH)}"
  if ! git -C "$SRC_DIR" fetch --all --quiet; then
    warn "git fetch не удался (сеть?) — продолжаю с локальным кодом"
  else
    [ -n "$BRANCH" ] || BRANCH="$(git -C "$SRC_DIR" rev-parse --abbrev-ref HEAD)"
    CUR="$(git -C "$SRC_DIR" rev-parse --abbrev-ref HEAD)"
    if git -C "$SRC_DIR" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
      # локальные правки не даём потерять молча и не даём им помешать pull/checkout
      if ! git -C "$SRC_DIR" diff --quiet || ! git -C "$SRC_DIR" diff --cached --quiet; then
        warn "Есть незакоммиченные правки — прячу в stash"
        git -C "$SRC_DIR" stash push -u -m "update-all.sh ${STAMP}" >/dev/null
      fi
      if [ "$BRANCH" != "$CUR" ] && ! git -C "$SRC_DIR" checkout --quiet "$BRANCH"; then
        warn "Не смог переключиться на ветку $BRANCH — остаюсь на $CUR"
        BRANCH="$CUR"
      fi
      if git -C "$SRC_DIR" pull --ff-only origin "$BRANCH"; then
        echo "   ветка: $BRANCH, коммит: $(git -C "$SRC_DIR" rev-parse --short HEAD)"
      else
        warn "git pull --ff-only не удался (ветки разошлись?) — продолжаю с текущим коммитом"
      fi
    else
      # Известные грабли: ветка существует только локально (как было с pr-1),
      # и pull из origin падает, роняя всё обновление. Нет ветки в origin —
      # это не ошибка: просто не делаем pull и раскатываем локальный код.
      warn "Ветка $BRANCH есть только локально (в origin её нет) — pull пропускаю, беру локальный код"
    fi
  fi
else
  warn "$SRC_DIR — не git-репозиторий. Обновляю из того, что лежит в папке."
fi

# ---------- общий код: один rsync на всех ----------
say "Раскладываю общий код в $CODE_DIR"
rsync -a --delete \
  --exclude 'data' --exclude '.env' --exclude '.git' --exclude 'node_modules' --exclude 'logs' \
  "$SRC_DIR"/ "$CODE_DIR"/
chown -R tgshop:tgshop "$CODE_DIR"

# ---------- параллельные задачи по магазинам ----------
mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR"/.*.status 2>/dev/null || true
trap 'warn "Прервано — останавливаю задачи"; kill $(jobs -p) 2>/dev/null; exit 130' INT TERM

# Задача одного магазина: бэкап его данных -> рестарт его сервиса ->
# проверка, что сервис жив и отвечает по своему порту. Весь вывод — в свой лог.
update_shop() {
  local s="$1" dir="$BASE_DIR/$1" log="$LOG_DIR/$1.log" st="$LOG_DIR/.$1.status"
  SECONDS=0
  {
    echo "=== $s: старт $(date '+%F %T') ==="
    echo "--- бэкап данных"
    if ! tar czf "/root/${s}-backup-${STAMP}.tgz" -C "$dir" data; then
      echo "fail: не смог сделать бэкап data/"; echo "fail:backup ${SECONDS}s" > "$st"; return
    fi
    echo "--- systemctl restart tg-shop@$s"
    if ! systemctl restart "tg-shop@${s}"; then
      echo "fail: systemctl restart вернул ошибку"; echo "fail:restart ${SECONDS}s" > "$st"; return
    fi
    local i up=0
    for i in $(seq 1 16); do   # до 8 секунд ждём, пока сервис станет active
      systemctl is-active --quiet "tg-shop@$s" && { up=1; break; }
      sleep 0.5
    done
    if [ "$up" != 1 ]; then
      echo "fail: сервис не поднялся за 8 секунд"
      echo "--- journalctl -u tg-shop@$s -n 15"; journalctl -u "tg-shop@$s" -n 15 --no-pager
      echo "fail:not-running ${SECONDS}s" > "$st"; return
    fi
    local port; port="$(sed -n 's/^PORT=//p' "$dir/.env" | head -n1)"
    if [ -n "$port" ] && command -v curl >/dev/null 2>&1; then
      if curl -s -m 5 -o /dev/null "http://127.0.0.1:${port}/"; then
        echo "http 127.0.0.1:${port} отвечает"
      else
        echo "warning: сервис active, но порт ${port} пока не отвечает"
      fi
    fi
    # Регресс-сводка по теме: печатаем реально сохранённый пресет и источник
    # цветов. scheme=telegram и светлые пресеты — частая причина «тема снова
    # белая», подсвечиваем их в общем итоге.
    local themeinfo
    themeinfo="$(node -e "try{const t=JSON.parse(require('fs').readFileSync('$dir/data/settings.json','utf8')).theme||{};console.log('preset='+(t.preset||'?')+' scheme='+(t.colorScheme||'?'))}catch(e){console.log('theme=?')}" 2>/dev/null || echo 'theme=?')"
    echo "тема: $themeinfo"
    echo "=== $s: готово за ${SECONDS} c ==="
    echo "ok ${SECONDS}s ${themeinfo}" > "$st"
  } >"$log" 2>&1
  # короткая строка в общий stdout (одна строка за раз — параллельные потоки не мешают)
  local status; status="$(cat "$st" 2>/dev/null)"
  if [[ "$status" == ok* ]]; then
    printf '   \033[1;32m✓\033[0m %s (%s)\n' "$s" "${status#ok }"
  else
    printf '   \033[1;31m✗\033[0m %s (%s — см. %s)\n' "$s" "$status" "$log"
  fi
}

say "Перезапускаю магазины — потоков: ${JOBS}, логи: ${LOG_DIR}/<имя>.log"
RUNNING=0
for s in "${SHOPS[@]}"; do
  update_shop "$s" &
  RUNNING=$((RUNNING + 1))
  while [ "$RUNNING" -ge "$JOBS" ]; do
    wait -n || true        # ждём завершения любой одной задачи и занимаем слот
    RUNNING=$((RUNNING - 1))
  done
done
wait || true
trap - INT TERM

# ---------- сводка ----------
say "Итоги обновления"
OK=(); FAILED=()
for s in "${SHOPS[@]}"; do
  st="$(cat "$LOG_DIR/.$s.status" 2>/dev/null || echo 'fail:unknown')"
  if [[ "$st" == ok* ]]; then
    OK+=("$s"); echo "   ✓ $s (${st#ok })"
  else
    FAILED+=("$s"); echo "   ✗ $s (${st})"
  fi
done
[ ${#MISSING[@]} -gt 0 ] && echo "   ? пропущены (нет на сервере): ${MISSING[*]}"

# Тема — больное место: светлая витрина «всплывает» только у покупателя.
# Подсвечиваем конфиги, при которых тёмный дизайн может стать белым.
for s in "${OK[@]}"; do
  st="$(cat "$LOG_DIR/.$s.status" 2>/dev/null)"
  case "$st" in *scheme=telegram*)
    warn "$s: scheme=telegram — витрина следует теме покупателя; у клиента со светлой темой она будет светлой" ;;
  esac
  case "$st" in *preset=market*|*preset=swiss*|*preset=bauhaus*|*preset=constructivist*)
    warn "$s: сохранён светлый пресет — если ждали тёмную витрину, проверьте админку" ;;
  esac
done

if [ ${#FAILED[@]} -gt 0 ]; then
  warn "Не поднялись: ${FAILED[*]}"
  for s in "${FAILED[@]}"; do
    echo; echo "--- ${s}: хвост лога $LOG_DIR/${s}.log"
    tail -n 12 "$LOG_DIR/${s}.log" 2>/dev/null | sed 's/^/   /'
    echo "   живые логи: journalctl -u tg-shop@${s} -n 40 --no-pager"
  done
  echo
  warn "Откат данных конкретного магазина: tar xzf /root/<имя>-backup-${STAMP}.tgz -C ${BASE_DIR}/<имя> && systemctl restart tg-shop@<имя>"
fi

say "Проверяю связь с Telegram"
if curl -sS -m 10 -o /dev/null https://api.telegram.org 2>/dev/null; then
  echo "   api.telegram.org отвечает"
else
  warn "api.telegram.org недоступен — боты работать не будут"
fi

echo
echo "Готово. Обновлено: ${#OK[@]}/${#SHOPS[@]}, ошибок: ${#FAILED[@]}. Бэкапы: /root/*-backup-${STAMP}.tgz, логи: ${LOG_DIR}/"
[ ${#FAILED[@]} -eq 0 ] || exit 1
