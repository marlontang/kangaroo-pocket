#!/usr/bin/env bash
#
# kangaroo-pocket - 应用管理脚本
#
#   ./server.sh start     启动应用
#   ./server.sh stop      退出应用
#   ./server.sh restart   重启应用
#   ./server.sh status    查看运行状态
#   ./server.sh dev       开发模式（热更新，前台运行）
#   ./server.sh package   打包 macOS + Windows 安装包
#   ./server.sh test      运行测试
#   ./server.sh clean     清理构建产物
#
# 详见 ./server.sh help

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

APP_NAME="kangaroo-pocket"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"

RELEASE_DIR="$ROOT/release"
LOG_DIR="$ROOT/logs"
PID_FILE="$LOG_DIR/app.pid"
APP_LOG="$LOG_DIR/app.log"

INSTALLED_APP="/Applications/$APP_NAME.app"
BUILT_APP_ARM="$RELEASE_DIR/mac-arm64/$APP_NAME.app"
BUILT_APP_X64="$RELEASE_DIR/mac/$APP_NAME.app"

# 判断构建是否落后于源码时，比对这些路径
SOURCE_PATHS=(src package.json electron.vite.config.ts)

# ── 输出 ──────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

info()  { echo "${C_BLUE}▸${C_RESET} $*"; }
ok()    { echo "${C_GREEN}✓${C_RESET} $*"; }
warn()  { echo "${C_YELLOW}!${C_RESET} $*"; }
err()   { echo "${C_RED}✗${C_RESET} $*" >&2; }
dim()   { echo "${C_DIM}$*${C_RESET}"; }

die() { err "$*"; exit 1; }

# ── 环境检查 ───────────────────────────────────────────────
require_node() {
  command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js 20+（https://nodejs.org）"
  local version_ok
  version_ok="$(node -p "const [major, minor] = process.versions.node.split('.').map(Number); major > 22 || (major === 22 && minor >= 5)")"
  if [[ "$version_ok" != "true" ]]; then
    die "Node.js 版本过低（当前 v$(node -p 'process.versions.node')），需要 22.5 或更高"
  fi
}

ensure_deps() {
  require_node
  if [[ ! -d node_modules ]]; then
    info "首次运行，正在安装依赖…"
    npm install || die "依赖安装失败"
    ok "依赖安装完成"
  fi
}

# 源码是否比某个产物新（产物不存在也算「需要重建」）
source_is_newer_than() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  [[ -n "$(find "${SOURCE_PATHS[@]}" -newer "$target" 2>/dev/null | head -1)" ]]
}

# 只在确有改动时才重新构建 —— 构建很快（~1 秒），但没必要每次都跑
build_if_stale() {
  if source_is_newer_than out/main/index.js; then
    info "代码有改动，重新构建…"
    npm run build >/dev/null || die "构建失败"
  fi
}

ensure_icon() {
  # 图标不入库，缺失时自动生成
  if [[ ! -f build/icon.icns || ! -f build/icon.png ]]; then
    info "生成应用图标…"
    node build/make-icon.mjs >/dev/null 2>&1 || warn "图标生成失败，将使用 Electron 默认图标"
  fi
}

# ── 进程管理 ───────────────────────────────────────────────
mkdir -p "$LOG_DIR"

# 找到正在运行的应用主进程 PID（排除 Electron 的 helper 子进程）
running_pid() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"; return 0
    fi
    rm -f "$PID_FILE"
  fi
  # 没有 PID 文件时（例如从访达手动启动），按可执行文件路径反查。
  # 只要主进程，排掉 Electron 的渲染/GPU 等 helper 子进程。
  local pid
  for pid in $(pgrep -f "$APP_NAME.app/Contents/MacOS/$APP_NAME" 2>/dev/null); do
    if ! ps -o command= -p "$pid" 2>/dev/null | grep -q -- '--type='; then
      echo "$pid"; return 0
    fi
  done
  return 0
}

# 挑一个可用的 .app：已安装 > arm64 产物 > x64 产物
resolve_app() {
  for candidate in "$INSTALLED_APP" "$BUILT_APP_ARM" "$BUILT_APP_X64"; do
    [[ -d "$candidate" ]] && { echo "$candidate"; return 0; }
  done
  return 1
}

# 启动：默认跑最新代码；--packaged 启动已打包/已安装的那份
cmd_start() {
  local mode="source"
  case "${1:-}" in
    --packaged|--app) mode="packaged" ;;
    '') ;;
    *) die "未知参数「${1}」，start 只接受 --packaged" ;;
  esac

  local pid
  pid="$(running_pid)"
  if [[ -n "$pid" ]]; then
    warn "应用已在运行（PID ${pid}）。如需重启：./server.sh restart"
    return 0
  fi

  local target
  if [[ "$mode" == "packaged" ]]; then
    local app
    if ! app="$(resolve_app)"; then
      warn "还没有打包产物，正在打包 macOS 版本…"
      cmd_package mac
      app="$(resolve_app)" || die "打包后仍未找到应用，请检查上面的输出"
    fi
    # 打包产物可能是很久以前打的，如实告知而不是默默启动旧版本
    if source_is_newer_than "$app/Contents/Resources/app.asar"; then
      warn "这个打包产物比当前代码旧，跑的不是最新版本"
      dim "  要用最新代码：./server.sh start（不带 --packaged）"
      dim "  要更新产物　：./server.sh package mac"
    fi
    info "启动打包产物 $app"
    target="$app/Contents/MacOS/$APP_NAME"
  else
    ensure_deps
    build_if_stale
    local electron_bin
    electron_bin="$(node -p "require('electron')" 2>/dev/null || true)"
    [[ -n "$electron_bin" && -x "$electron_bin" ]] || \
      die "Electron 包已安装，但可执行文件不存在；请删除 node_modules/electron 后重新运行 npm install"
    info "启动最新代码（out/ 构建产物）"
    target="$electron_bin"
  fi

  # 直接拉起可执行文件（而非 open），这样脚本能拿到 PID 用于 stop/status
  if [[ "$mode" == "packaged" ]]; then
    nohup "$target" >>"$APP_LOG" 2>&1 &
  else
    nohup "$target" "$ROOT" >>"$APP_LOG" 2>&1 &
  fi
  local new_pid=$!
  echo "$new_pid" >"$PID_FILE"

  sleep 1.5
  if kill -0 "$new_pid" 2>/dev/null; then
    ok "已启动（PID ${new_pid}）"
    dim "  日志：$APP_LOG"
  else
    rm -f "$PID_FILE"
    err "启动失败，最后 20 行日志："
    tail -20 "$APP_LOG" >&2 || true
    exit 1
  fi
}

cmd_stop() {
  local pid
  pid="$(running_pid)"
  if [[ -z "$pid" ]]; then
    warn "应用没有在运行"
    rm -f "$PID_FILE"
    return 0
  fi

  info "正在退出（PID ${pid}）…"
  kill "$pid" 2>/dev/null || true

  # 等它自己退干净，最多 10 秒
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done

  if kill -0 "$pid" 2>/dev/null; then
    warn "进程未响应，强制结束"
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.5
  fi

  rm -f "$PID_FILE"
  ok "已退出"
}

cmd_restart() {
  cmd_stop
  sleep 0.5
  cmd_start "$@"
}

cmd_status() {
  local pid
  pid="$(running_pid)"
  echo "${C_BOLD}$APP_NAME${C_RESET} v$VERSION"
  if [[ -n "$pid" ]]; then
    ok "运行中（PID ${pid}）"
    # 顺带显示占用的内存，方便判断是否异常
    ps -o rss=,etime= -p "$pid" 2>/dev/null | awk '{printf "  内存 %.0f MB · 已运行 %s\n", $1/1024, $2}' || true
  else
    dim "  未运行"
  fi

  echo
  echo "${C_BOLD}代码构建${C_RESET}"
  if [[ ! -e out/main/index.js ]]; then
    dim "  尚未构建 —— ./server.sh start 会自动构建"
  elif source_is_newer_than out/main/index.js; then
    warn "已过期（源码有更新的改动）—— ./server.sh start 会自动重新构建"
  else
    ok "是最新的"
  fi

  echo
  echo "${C_BOLD}打包产物（./server.sh start --packaged 启动这个）${C_RESET}"
  local found=0
  for candidate in "$INSTALLED_APP" "$BUILT_APP_ARM" "$BUILT_APP_X64"; do
    if [[ -d "$candidate" ]]; then
      if source_is_newer_than "$candidate/Contents/Resources/app.asar"; then
        echo "  $candidate  ${C_YELLOW}（比当前代码旧）${C_RESET}"
      else
        echo "  $candidate  ${C_DIM}（最新）${C_RESET}"
      fi
      found=1
    fi
  done
  (( found )) || dim "  无 —— 运行 ./server.sh package 生成"

  echo
  echo "${C_BOLD}安装包${C_RESET}"
  if compgen -G "$RELEASE_DIR/*.dmg" >/dev/null || compgen -G "$RELEASE_DIR/*.exe" >/dev/null; then
    for f in "$RELEASE_DIR"/*.dmg "$RELEASE_DIR"/*.exe; do
      [[ -f "$f" ]] && printf "  %s  %s\n" "$(du -h "$f" | cut -f1)" "$f"
    done
  else
    dim "  无 —— 运行 ./server.sh package 生成"
  fi
}

# ── 开发与构建 ─────────────────────────────────────────────
cmd_dev() {
  ensure_deps
  info "开发模式启动（Ctrl+C 退出）"
  dim "  代码改动会自动热更新"
  exec npm run dev
}

cmd_build() {
  ensure_deps
  info "构建应用代码…"
  npm run build
  ok "构建完成 → out/"
}

# 打包：./server.sh package [mac|win|all]
cmd_package() {
  local targets="${1:-both}"

  # 先校验参数，再做耗时的构建
  local mac_ok=0 win_ok=0 want_mac=0 want_win=0 mac_args=()
  case "$targets" in
    mac)  want_mac=1; mac_args=(--arm64) ;;
    win)  want_win=1 ;;
    all)  want_mac=1; want_win=1; mac_args=(--arm64 --x64) ;;
    both) want_mac=1; want_win=1; mac_args=(--arm64) ;;
    *)    die "未知的打包目标「${targets}」，可选：mac / win / all（不传则同时打 mac 与 win）" ;;
  esac

  ensure_deps
  ensure_icon

  info "构建应用代码…"
  npm run build >/dev/null || die "代码构建失败"

  if (( want_mac )); then
    echo
    info "打包 macOS 安装包（dmg）…"
    if npx electron-builder --mac "${mac_args[@]}"; then
      mac_ok=1
      ok "macOS 打包完成"
    else
      err "macOS 打包失败"
    fi
  fi

  if (( want_win )); then
    echo
    info "打包 Windows 安装包（exe）…"
    if npx electron-builder --win --x64; then
      win_ok=1
      ok "Windows 打包完成"
    else
      err "Windows 打包失败"
      dim "  在 macOS 上交叉编译 Windows 安装包需要联网下载工具链，"
      dim "  若持续失败，可在 Windows 机器上克隆本项目后运行：./server.sh package win"
    fi
  fi

  echo
  echo "${C_BOLD}产物${C_RESET}"
  local any=0
  for f in "$RELEASE_DIR"/*.dmg "$RELEASE_DIR"/*.exe; do
    [[ -f "$f" ]] || continue
    printf "  %-6s %s\n" "$(du -h "$f" | cut -f1)" "$f"
    any=1
  done
  (( any )) || warn "没有生成任何安装包"

  echo
  if (( want_mac && mac_ok )); then
    dim "macOS：双击 dmg 后把应用拖进「应用程序」。未做代码签名，"
    dim "       首次打开需右键点击应用图标 →「打开」。"
  fi
  if (( want_win && win_ok )); then
    dim "Windows：双击 exe 按向导安装（装到当前用户目录，无需管理员权限）。"
    dim "         未做代码签名，首次运行 SmartScreen 会提示，点「更多信息」→「仍要运行」。"
  fi

  # 只要有想打但没打成的目标，就以失败退出，方便 CI 感知
  if (( want_mac && !mac_ok )) || (( want_win && !win_ok )); then
    return 1
  fi
}

cmd_test() {
  ensure_deps
  local kind="${1:-unit}"
  case "$kind" in
    unit) info "运行单元测试…";        npm test ;;
    e2e)  info "运行端到端测试…";      npm run test:e2e ;;
    ui)   info "运行界面交互测试…";    npm run test:ui ;;
    llm)  info "运行真实接口测试（会产生 API 费用）…"; npm run test:llm ;;
    pkg)  info "运行打包产物冒烟测试…"; npm run test:pkg ;;
    all)
      info "运行全部测试…"
      npm test && npm run test:ui && npm run test:e2e && npm run test:llm
      ;;
    *) die "未知的测试类型「${kind}」，可选：unit / ui / e2e / llm / pkg / all" ;;
  esac
}

cmd_logs() {
  [[ -f "$APP_LOG" ]] || die "还没有日志文件，应用尚未通过 ./server.sh start 启动过"
  if [[ "${1:-}" == "-f" ]]; then
    info "跟踪日志（Ctrl+C 退出）：$APP_LOG"
    tail -f "$APP_LOG"
  elif [[ ! -s "$APP_LOG" ]]; then
    # 应用正常运行时不往 stdout 写东西，空日志是正常现象
    dim "日志为空 —— 应用运行正常时不产生输出，这里只会记录崩溃和错误信息。"
    dim "  日志文件：$APP_LOG"
  else
    tail -100 "$APP_LOG"
  fi
}

cmd_clean() {
  local pid
  pid="$(running_pid)"
  [[ -n "$pid" ]] && { warn "应用正在运行，先退出它"; cmd_stop; }

  info "清理构建产物…"
  rm -rf out release logs
  ok "已清理 out/ release/ logs/"
  dim "  node_modules 保留。要彻底重置：rm -rf node_modules && npm install"
}

cmd_help() {
  cat <<EOF
${C_BOLD}$APP_NAME${C_RESET} v$VERSION —— 应用管理脚本

${C_BOLD}用法${C_RESET}
  ./server.sh <命令> [参数]

${C_BOLD}运行${C_RESET}
  start              启动应用。会先检查代码有无改动，有则自动重新构建，
                     保证跑的一定是最新代码
  start --packaged   改为启动已打包/已安装的那份（比代码旧时会提示）
  stop               退出应用
  restart            重启应用
  status             查看运行状态、可用应用与安装包
  logs [-f]          查看应用日志，-f 持续跟踪

${C_BOLD}开发${C_RESET}
  dev                开发模式，热更新，前台运行
  build              只构建代码到 out/
  test [类型]        运行测试
                       unit  单元测试（默认，不联网）
                       ui    界面交互测试，逐个点击每个按钮
                       e2e   端到端测试，启动真实应用走完整链路
                       llm   真实接口分类准确率测试（产生 API 费用）
                       pkg   打包产物冒烟测试
                       all   以上除 pkg 外全跑

${C_BOLD}打包${C_RESET}
  package            打包 macOS(arm64) + Windows(x64) 安装包
  package mac        只打 macOS
  package win        只打 Windows
  package all        macOS(arm64 + x64) + Windows(x64)

${C_BOLD}其他${C_RESET}
  clean              清理 out/ release/ logs/
  help               显示本帮助

${C_BOLD}产物位置${C_RESET}
  release/$APP_NAME-$VERSION-arm64.dmg          macOS 安装包
  release/$APP_NAME-$VERSION-setup-x64.exe      Windows 安装包
EOF
}

# ── 入口 ──────────────────────────────────────────────────
case "${1:-help}" in
  start)          shift; cmd_start "$@" ;;
  stop)           shift; cmd_stop "$@" ;;
  restart)        shift; cmd_restart "$@" ;;
  status)         shift; cmd_status "$@" ;;
  logs)           shift; cmd_logs "$@" ;;
  dev)            shift; cmd_dev "$@" ;;
  build)          shift; cmd_build "$@" ;;
  package|dist)   shift; cmd_package "$@" ;;
  test)           shift; cmd_test "$@" ;;
  clean)          shift; cmd_clean "$@" ;;
  help|-h|--help) cmd_help ;;
  *)
    err "未知命令「${1}」"
    echo
    cmd_help
    exit 1
    ;;
esac
