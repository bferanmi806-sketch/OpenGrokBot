#!/bin/bash
# bot 容器启动序列：X 显示器 → VNC → 有头 Chromium（CDP）→ shim（前台，同时给 CDP 把门）
set -euo pipefail

export DISPLAY=:99
mkdir -p /workspace/files

# 浏览器配置优先放在独立挂载点 /var/lib/bot-browser（不在 /workspace 里，文件工具碰不到 Cookie 库）；
# 老容器存在 /workspace/.browser 里的登录态在首次切换时整目录迁过去，不丢会话。
BROWSER_DIR=/workspace/.browser
if [ -d /var/lib/bot-browser ]; then
  BROWSER_DIR=/var/lib/bot-browser
  if [ -d /workspace/.browser ] && [ -z "$(ls -A /var/lib/bot-browser 2>/dev/null)" ]; then
    cp -a /workspace/.browser/. /var/lib/bot-browser/ 2>/dev/null && rm -rf /workspace/.browser || true
  fi
fi
mkdir -p "$BROWSER_DIR"

# 上一次运行留下的 X 锁会让重启后的 Xvfb 直接罢工（"Server is already active for display 99"），
# 于是整台电脑陷入重启循环。容器里此刻只有我们自己，删掉是安全的。
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

# 守护：进程退了就拉起来。接管登录时用户随手关掉浏览器窗口，这台电脑也不该从此没有浏览器。
keep() {
  set +e
  local name=$1
  shift
  while true; do
    "$@"
    echo "[entrypoint] $name exited ($?), restarting in 1s" >&2
    sleep 1
  done
}

run_xvfb() {
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp
}

run_chromium() {
  # Chromium 的单例锁：非正常退出会留下 SingletonLock 指向已消失的 pid
  rm -f "$BROWSER_DIR/SingletonLock" "$BROWSER_DIR/SingletonSocket" "$BROWSER_DIR/SingletonCookie"
  # Chromium 会无视 --remote-debugging-address，始终只监听 127.0.0.1，
  # 所以让它开在内部的 9223；对外的 9222 由 shim 验过口令再转进来。
  # 被拉起来（重建、OOM、守护重启）之后别弹「恢复页面？」：它会挡住 bot 的截图和点击。
  chromium \
    --no-sandbox --disable-dev-shm-usage --disable-gpu \
    --remote-debugging-port=9223 \
    --user-data-dir="$BROWSER_DIR" \
    --window-position=0,0 --window-size=1280,800 \
    --no-first-run --no-default-browser-check --disable-features=Translate \
    --hide-crash-restore-bubble \
    about:blank
}

keep xvfb run_xvfb &
for _ in $(seq 1 60); do
  xdpyinfo -display :99 >/dev/null 2>&1 && break
  sleep 0.25
done
xdpyinfo -display :99 >/dev/null 2>&1 || { echo "[entrypoint] Xvfb failed to start" >&2; exit 1; }

# 屏幕要口令：网关在建容器时生成 VNC_PASSWORD，只交给已登录的面板。
# x11vnc 只听容器内回环，外面只能经 websockify（6080）进来；存好口令文件后立刻从环境里抹掉。
VNC_AUTH=(-nopw)
if [ -n "${VNC_PASSWORD:-}" ]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/.vncpass >/dev/null 2>&1
  VNC_AUTH=(-rfbauth /tmp/.vncpass)
fi
unset VNC_PASSWORD
keep x11vnc x11vnc -display :99 -forever -shared -localhost "${VNC_AUTH[@]}" -quiet -rfbport 5900 &
# 只转发 VNC 数据流：屏幕的网页由网关自己提供，不从这台（bot 能改的）电脑上取
keep websockify websockify 6080 localhost:5900 &
keep chromium run_chromium &

exec node /opt/shim.mjs
