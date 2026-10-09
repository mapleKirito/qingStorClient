#!/bin/bash
# 青云对象存储客户端 —— macOS 双击启动脚本
# 功能：检测 Python 环境 → 准备虚拟环境与依赖 → 启动客户端
# 用法：Finder 中双击 run.command（首次若被拦截，右键 → 打开）

set -e
trap 'echo; echo "----------------------------------------"; echo "执行出错，窗口暂停以便查看。按回车关闭..."; read -r _' ERR

# 双击运行时工作目录通常是用户主目录，先切到脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
echo "==> 工作目录: $SCRIPT_DIR"

# 1) 查找 python3（系统自带 / Homebrew / python.org 安装）
PY=""
for p in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if command -v "$p" >/dev/null 2>&1; then PY="$p"; break; fi
done

if [ -z "$PY" ]; then
  echo "[错误] 未找到 Python3。"
  echo "请先安装 Python 3.9+，推荐："
  echo "  - 访问 https://www.python.org/downloads/ 下载安装（最稳）"
  echo "  - 或安装 Homebrew 后执行: brew install python@3.11"
  osascript -e 'display alert "未找到 Python3" message "请先安装 Python 3.9+。\n推荐访问 python.org 下载安装，完成后重新双击本脚本。" as critical giving up after 20' >/dev/null 2>&1 || true
  exit 1
fi

echo "==> 检测到解释器: $("$PY" --version 2>&1)  ($PY)"

# 2) 版本校验（需 >= 3.9）
"$PY" - <<'PYEOF'
import sys
print("版本:", sys.version.split()[0])
raise SystemExit(0 if sys.version_info >= (3, 9) else 1)
PYEOF

# 3) 虚拟环境与依赖（首次自动创建）
if [ ! -d ".venv" ]; then
  echo "==> 首次运行，创建虚拟环境 .venv ..."
  "$PY" -m venv .venv
fi

# shellcheck disable=SC1091
source ".venv/bin/activate"

echo "==> 安装/更新依赖 ..."
python -m pip install --upgrade pip
pip install -r requirements.txt

# 4) 启动客户端（替换当前进程）
echo "==> 启动客户端 ..."
exec python main.py
