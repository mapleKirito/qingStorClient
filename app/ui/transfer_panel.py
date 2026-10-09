"""传输管理面板：非阻塞展示后台上传/下载任务进度，不影响主界面交互。"""
from __future__ import annotations

from typing import Dict, Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QFrame, QHBoxLayout, QHeaderView, QLabel, QProgressBar, QPushButton,
    QTreeWidget, QTreeWidgetItem, QVBoxLayout, QWidget,
)


def _fmt_size(n: float) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    f = float(n)
    for u in units:
        if f < 1024 or u == units[-1]:
            return f"{f:.1f} {u}" if u != "B" else f"{int(f)} {u}"
        f /= 1024
    return f"{n} B"


_COL_TITLE, _COL_PROGRESS, _COL_STATUS = 0, 1, 2


class TransferPanel(QWidget):
    """底部传输列表面板。每个任务一行：标题 / 进度条 / 状态。"""

    # task_id -> 用户点击了该任务的取消
    cancel_requested = Signal(str)

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        self._recs: Dict[str, tuple] = {}  # task_id -> (item, bar, is_bytes)
        self._finished: set = set()        # 已结束（成功/失败/取消）的 task_id

        root = QVBoxLayout(self)
        root.setContentsMargins(4, 4, 4, 4)
        root.setSpacing(4)

        top = QHBoxLayout()
        title = QLabel("传输管理")
        title.setStyleSheet("font-weight: bold;")
        top.addWidget(title)
        top.addStretch(1)
        self.btn_clear = QPushButton("清理已完成")
        self.btn_clear.clicked.connect(self.clear_finished)
        top.addWidget(self.btn_clear)
        self.btn_cancel = QPushButton("取消所选任务")
        self.btn_cancel.clicked.connect(self._on_cancel_selected)
        top.addWidget(self.btn_cancel)
        root.addLayout(top)

        self.tree = QTreeWidget()
        self.tree.setColumnCount(3)
        self.tree.setHeaderLabels(["任务", "进度", "状态"])
        self.tree.setRootIsDecorated(False)
        self.tree.setItemsExpandable(False)
        self.tree.setSelectionMode(QTreeWidget.SingleSelection)
        h = self.tree.header()
        h.setSectionResizeMode(_COL_TITLE, QHeaderView.Stretch)
        h.setSectionResizeMode(_COL_PROGRESS, QHeaderView.Fixed)
        self.tree.setColumnWidth(_COL_PROGRESS, 220)
        root.addWidget(self.tree, 1)

    # ---------- 任务生命周期 ----------
    def start_task(self, task_id: str, title: str, is_bytes: bool):
        item = QTreeWidgetItem([title, "", "排队中…"])
        self.tree.addTopLevelItem(item)
        bar = QProgressBar()
        bar.setRange(0, 100)
        bar.setValue(0)
        bar.setTextVisible(True)
        self.tree.setItemWidget(item, _COL_PROGRESS, bar)
        self._recs[task_id] = (item, bar, is_bytes)
        self.tree.setCurrentItem(item)
        self.tree.scrollToItem(item)

    def update_progress(self, task_id: str, done: int, total: int, current: str):
        rec = self._recs.get(task_id)
        if not rec:
            return
        item, bar, is_bytes = rec
        if total > 0:
            pct = int(done * 100 / total)
            bar.setRange(0, 100)
            bar.setValue(pct)
            bar.setFormat(f"{pct}%")
            detail = (f"{_fmt_size(done)}/{_fmt_size(total)}" if is_bytes
                      else f"{done}/{total} 个文件")
        else:
            bar.setRange(0, 0)  # 忙碌态
            detail = "计算中…"
        item.setText(_COL_STATUS, f"{current} · {detail}" if current else detail)

    def finish_task(self, task_id: str, success: bool, msg: str):
        rec = self._recs.get(task_id)
        if not rec:
            return
        item, bar, _ = rec
        bar.setRange(0, 100)
        if success:
            bar.setValue(100)
            bar.setFormat("100%")
        item.setText(_COL_STATUS, msg)
        self._finished.add(task_id)

    def clear_finished(self):
        """移除所有已结束（成功/失败/取消）的任务记录，保留进行中的。"""
        for task_id in list(self._finished):
            rec = self._recs.pop(task_id, None)
            if rec:
                item, _bar, _ = rec
                idx = self.tree.indexOfTopLevelItem(item)
                if idx >= 0:
                    self.tree.takeTopLevelItem(idx)
        self._finished.clear()

    # ---------- 交互 ----------
    def _on_cancel_selected(self):
        item = self.tree.currentItem()
        if not item:
            return
        for task_id, (it, _bar, _) in self._recs.items():
            if it is item:
                self.cancel_requested.emit(task_id)
                item.setText(_COL_STATUS, "正在取消…")
                return
