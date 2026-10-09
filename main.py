"""青云对象存储本地客户端入口。

运行： python main.py
首次启动会弹窗要求填写 endpoint / Access Key / Secret Key / Bucket（可选子目录前缀）。
"""
from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from app.config import ConfigManager
from app.ui.config_dialog import ConfigDialog
from app.ui.main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("QingStor Client")

    cfg = ConfigManager.load()
    first_run = cfg is None or not cfg.is_complete()

    if first_run:
        dlg = ConfigDialog(cfg, first_run=True)
        # 取消则退出
        if dlg.exec() != dlg.Accepted:
            return 0
        cfg = dlg.cfg

    # 再次确认配置完整（用户可能清除后重填）
    cfg = ConfigManager.load()
    if cfg is None or not cfg.is_complete():
        return 0

    win = MainWindow(cfg)
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
