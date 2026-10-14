#!/usr/bin/env bash
# Matjarak 2.0 — المرحلة 0: بيئة محلية مؤقتة للّقطات المرجعية فقط.
# MySQL في Docker (127.0.0.1:3324) + مخطط من ملف schema-only + بيانات تجريبية (seed.ts) + خادم التطبيق على :3008.
# لا Staging ولا Production: الرابط محلي ثابت، وبوسطة على عنوان Mock (DEPLOY_ENV=development)، والجدولة الخلفية معطلة.
# الاستخدام: SCHEMA_SQL=/path/to/test-schema.sql bash tools/ui-baseline/live.sh   (من جذر المستودع)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
export PATH="$HOME/.docker/bin:$PATH"
CT=mj-ui-baseline; PORT_DB=3324; DB=matjarak_ui_baseline
: "${SCHEMA_SQL:?SCHEMA_SQL must point to a schema-only dump (no data)}"
export DATABASE_URL="mysql://root:root@127.0.0.1:${PORT_DB}/${DB}"
# أسرار الجلسة وكلمة مرور الموظفين التجريبيين: عشوائية لكل تشغيل، لا تُكتب في المستودع. سر الجلسة يُحفظ خارج
# المستودع (ملف 0600 في مجلد المؤقتات) ليقرأه capture.mjs؛ كلمة المرور لا يحتاجها أحد (الالتقاط بجلسات موقّعة).
SECRET_FILE="${TMPDIR:-/tmp}/matjarak-ui-baseline.secret"
( umask 077; openssl rand -hex 32 > "$SECRET_FILE" )
export JWT_SECRET="$(cat "$SECRET_FILE")"
export OWNER_TEST_PASSWORD="$(openssl rand -hex 16)"
export PORT=3008 NODE_ENV=development DEPLOY_ENV=development DISABLE_MAINTENANCE_SCHEDULER=true
unset BOSTA_API_KEY BOSTA_BASE_URL BOSTA_WEBHOOK_SECRET
if ! docker ps --format '{{.Names}}' | grep -q "^${CT}$"; then
  docker rm -f "$CT" >/dev/null 2>&1 || true
  docker run -d --name "$CT" -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE="$DB" -p "127.0.0.1:${PORT_DB}:3306" mysql:8 >/dev/null
  for i in $(seq 1 60); do docker exec "$CT" mysqladmin ping -h127.0.0.1 -uroot -proot --silent >/dev/null 2>&1 && break; sleep 2; done
  sleep 3
  docker exec -i "$CT" mysql --default-character-set=utf8mb4 -uroot -proot "$DB" < "$SCHEMA_SQL"
  npx tsx tools/ui-baseline/seed.ts | tee "${SEED_OUT:-/dev/null}"
fi
exec npx tsx server/_core/index.ts
