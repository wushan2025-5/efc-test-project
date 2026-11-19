#!/usr/bin/env bash
# Backend-real 探针：请求部署后的站点，打印观测值并对能确定的项给出判定。
#
# 用法：
#   ./probe.sh https://<域名>            # 线上
#   ./probe.sh http://127.0.0.1:3201     # 本地（见 README「本地验证」）
#   FILLER_MB=199.2 ./probe.sh <base>    # 额外核对填充体积与构建参数一致
#   BIG=1 ./probe.sh <base>              # 额外跑 200MB 下载、100MB 上传
#
# 判定：✓ 与 README 观测表的「现状」一致；✗ 不一致（需要人工看）；· 只打印观测值。
set -u
BASE=${1:?用法: ./probe.sh <base-url>}
BASE=${BASE%/}
P="$BASE/__probe"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

# ---- 工具函数 ----
section() { printf '\n== %s\n' "$1"; }
info() { printf '  · %s\n' "$*"; }
check() { # 描述 预期 实际
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1))
    printf '  ✓ %s（%s）\n' "$1" "$3"
  else
    FAIL=$((FAIL + 1))
    printf '  ✗ %s：预期 %s，实际 %s\n' "$1" "$2" "$3"
  fi
}
# fetch <url> [curl 参数...]：响应头写 $TMP/h，body 写 $TMP/b，状态码写 $STATUS
fetch() {
  local url=$1
  shift
  curl -s -m 120 -D "$TMP/h" -o "$TMP/b" "$@" "$url"
  # 取最后一个状态行，跳过上传时的 100 Continue
  STATUS=$(grep -E '^HTTP/' "$TMP/h" 2>/dev/null | tail -1 | awk '{print $2}')
}
hdr() { grep -i "^$1:" "$TMP/h" | head -1 | cut -d' ' -f2- | tr -d '\r'; }
# json <键>：取 body 里第一个同名键的值（只适合标量）
json() { grep -oE "\"$1\":(\"[^\"]*\"|[^,}]*)" "$TMP/b" | head -1 | cut -d: -f2- | tr -d '"'; }
# jpath <表达式>：用 node 取嵌套字段，本机没有 node 时输出空
jpath() {
  if command -v node >/dev/null; then
    node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],d);process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))' "$TMP/b" "$1" 2>/dev/null
  fi
}
sha() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -c1-64
  else
    shasum -a 256 "$1" | cut -c1-64
  fi
}
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
# dt <后> <前>：两个时间点相减，保留 1 位小数
dt() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f", a - b }'; }
# 并发请求：每行输出一个 x-probe-instance
cat > "$TMP/w.sh" <<'EOF'
curl -s -m 60 -D - -o /dev/null "$1" | tr -d '\r' | grep -i '^x-probe-instance:' | head -1 | cut -d' ' -f2
EOF
par() { seq "$2" | xargs -P "$2" -I{} bash "$TMP/w.sh" "$1"; }

echo "Backend-real probe  base=$BASE"

section "首个请求（冷启动时包含拉代码和启动）"
T0=$(now)
fetch "$P/whoami"
T1=$(now)
check "whoami 可访问" 200 "$STATUS"
info "首个请求耗时 $(dt "$T1" "$T0")s，instance=$(json instance) uptimeSec=$(json uptimeSec)（uptime 很小=本次请求触发了冷启动）"

section "启动与运行环境（/__probe/boot）"
fetch "$P/boot"
check "boot 可访问" 200 "$STATUS"
info "node=$(json node) platform=$(json platform) cpus=$(json cpus) totalMemMb=$(json totalMemMb)"
info "进程启动→模块加载 $(jpath boot.moduleLoadMs)ms，→监听 $(jpath boot.listenMs)ms，→首个请求 $(jpath boot.firstRequestMs)ms"
info "应用目录 $(json appFiles) 个文件，$(json appBytes) bytes；cwd=$(json cwd)"
info "env: $(jpath env)"
info "运行时钩子 hooked=$(json hooked)（false=没有注入 ESA_RUNTIME_LOG_*，日志采集未开）"

section "填充文件（code.zip 体积，/__probe/filler?verify=1）"
fetch "$P/filler?verify=1"
if [ "$STATUS" = 404 ]; then
  info "没有填充文件（构建命令未执行 gen-filler）"
else
  check "填充文件完整（sha256 逐块一致）" true "$(json ok)"
  info "$(json totalBytes) bytes，读取+校验 $(json ms)ms，$(json mbPerSec) MB/s"
  if [ -n "${FILLER_MB:-}" ]; then
    fetch "$P/filler"
    check "填充体积与构建参数一致" "$FILLER_MB" "$(json sizeMb)"
  fi
fi

section "原生模块（@node-rs/xxhash）"
fetch "$P/native"
check "原生模块加载并算出正确哈希" true "$(json ok)"
info "platform=$(json platform) bindings=$(jpath bindings)"
if [ "$STATUS" != 200 ]; then
  info "$(head -c 600 "$TMP/b")"
fi

section "子进程 / worker 里的运行时钩子（/__probe/child）"
fetch "$P/child"
MAIN=$(jpath main.hooked)
info "tag=$(json tag)  main=$MAIN spawn=$(jpath spawn.hooked) worker=$(jpath worker.hooked)"
if [ "$MAIN" = true ]; then
  check "spawn 子进程继承钩子（NODE_OPTIONS --require）" true "$(jpath spawn.hooked)"
  check "worker 不经过钩子（已知限制）" false "$(jpath worker.hooked)"
  info "去日志后台搜 tag：应有 main、spawn 两条，worker 那条不会出现"
else
  info "钩子未安装，跳过判定"
fi

section "日志采集（/__probe/log）"
fetch "$P/log?size=40000"
info "已输出，去日志后台搜索 tag：$(json tag)（console 各级别、console.dir、stdout/stderr、多行、中文、stack、40KB 长日志）"
info "现状：只采集 console.*；stdout.write / stderr.write 两条不会出现；长日志截断到 32KiB"

section "WebSocket（/__probe/ws）"
if command -v node >/dev/null && node -e 'process.exit(typeof WebSocket === "function" ? 0 : 1)' 2>/dev/null; then
  WS=$(printf '%s' "$P/ws" | sed -e 's#^http://#ws://#' -e 's#^https://#wss://#')
  OUT=$(node -e '
    const ws = new WebSocket(process.argv[1]);
    const got = [];
    const timer = setTimeout(() => { console.log("timeout " + got.join("|")); process.exit(0); }, 10000);
    ws.onmessage = (e) => {
      got.push(String(e.data));
      if (got.length === 1) { ws.send("ping-probe"); }
      if (got.length === 2) { clearTimeout(timer); console.log(got[1] === "ping-probe" ? "echo-ok" : "echo-bad " + got[1]); ws.close(); }
    };
    ws.onerror = (e) => { clearTimeout(timer); console.log("error " + (e.message || e.type)); process.exit(0); };
  ' "$WS" 2>&1)
  check "ws 握手并回显" echo-ok "$OUT"
else
  info "本机 node 没有全局 WebSocket（需要 Node ≥ 22），跳过"
fi

section "跨实例（/__probe/whoami ×40 并发）"
par "$P/whoami" 40 > "$TMP/p1"
info "40 并发打出的实例数：$(sort -u "$TMP/p1" | grep -c .)"

section "流式与大响应"
T0=$(now)
FIRST=
while IFS= read -r line; do
  if [ -z "$FIRST" ] && [ "${line#data:}" != "$line" ]; then
    FIRST=$(now)
  fi
done < <(curl -sN -m 30 "$P/sse?n=5")
T1=$(now)
info "sse n=5：首条到达 $(dt "${FIRST:-$T1}" "$T0")s，结束 $(dt "$T1" "$T0")s（首条 ≈0s=逐条下发；≈4s=被缓冲）"
BIGS="50"
UPS="3 20"
if [ "${BIG:-0}" = "1" ]; then
  BIGS="50 200"
  UPS="3 20 100"
fi
for MB in $BIGS; do
  fetch "$P/big?mb=$MB" -w '%{time_total}' > "$TMP/t"
  check "big ${MB}MB 字节数" "$(hdr x-probe-bytes)" "$(wc -c < "$TMP/b" | tr -d ' ')"
  info "big ${MB}MB 耗时 $(cat "$TMP/t")s"
done
for MB in $UPS; do
  head -c $((MB * 1048576)) /dev/urandom > "$TMP/up"
  fetch "$P/upload" -X POST --data-binary @"$TMP/up" -H 'content-type: application/octet-stream' -w '%{time_total}' > "$TMP/t"
  if [ "$STATUS" = 200 ]; then
    check "upload ${MB}MB sha256" "$(sha "$TMP/up")" "$(json sha256)"
    info "upload ${MB}MB 耗时 $(cat "$TMP/t")s"
  else
    info "upload ${MB}MB → ${STATUS}（请求体上限）"
  fi
done

section "路由"
fetch "$BASE/"
check "/ 列出探针" Backend-real "$(json name)"
fetch "$BASE/__probe/not-exist"
check "未知路径由 Express 返回 404" 404 "$STATUS"

printf '\n合计：✓ %s  ✗ %s\n' "$PASS" "$FAIL"
