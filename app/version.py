"""版本信息集中管理（单一数据源）。

修改版本时只需改这里；界面标题、状态栏、关于、启动日志均从此读取。
"""
from __future__ import annotations

__version__ = "1.0.0"
BUILD_DATE = "2026-10-09"

APP_NAME = "青云对象存储客户端"

# 版本历史：新版本追加在最前
VERSION_HISTORY = [
    ("1.0.0", "2026-10-09", "首个可用版本：网盘式浏览、多选/文件夹上传下载、右键菜单、"
                             "面包屑导航、传输管理面板、跨平台文件名编码、子目录前缀隔离。"),
]


def version_text() -> str:
    lines = [f"{APP_NAME}  v{__version__}  (build {BUILD_DATE})", ""]
    lines.append("版本历史：")
    for ver, date, note in VERSION_HISTORY:
        lines.append(f"  v{ver}  ({date})  {note}")
    return "\n".join(lines)
