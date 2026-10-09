"""主窗口：左侧目录树 + 右侧文件列表，网盘式操作。"""
from __future__ import annotations

import os
from datetime import datetime
from typing import List, Optional

from PySide6.QtCore import Qt, QSize
from PySide6.QtGui import QAction, QIcon
from PySide6.QtWidgets import (
    QAbstractItemView, QDialog, QFileDialog, QHBoxLayout, QHeaderView,
    QInputDialog, QLabel, QMainWindow, QMessageBox, QProgressDialog,
    QSplitter, QToolBar, QTreeWidget, QTreeWidgetItem, QVBoxLayout,
    QWidget, QStyle,
)

from ..config import AppConfig
from ..storage import StorageClient, StorageError, ObjectItem
from .. import path_utils
from .config_dialog import ConfigDialog
from .transfer import TransferWorker, SelectedItem


COL_NAME, COL_SIZE, COL_TIME, COL_KEY = 0, 1, 2, 3


def _fmt_size(n: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    f = float(n)
    for u in units:
        if f < 1024 or u == units[-1]:
            return f"{f:.1f} {u}" if u != "B" else f"{int(f)} {u}"
        f /= 1024
    return f"{n} B"


def _fmt_time(dt: Optional[datetime]) -> str:
    if not dt:
        return ""
    try:
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(dt)


class MainWindow(QMainWindow):
    def __init__(self, cfg: AppConfig):
        super().__init__()
        self.cfg = cfg
        self.storage = StorageClient(cfg)
        self.current_dir: str = ""  # 相对 prefix 的当前目录
        self.worker: Optional[TransferWorker] = None
        self.progress_dlg: Optional[QProgressDialog] = None
        self._build_ui()
        self._load_root()

    # ---------- UI 构建 ----------
    def _build_ui(self):
        self.setWindowTitle("青云对象存储客户端" + (f"  [{self.cfg.bucket}]" if self.cfg.bucket else ""))
        self.resize(1100, 680)

        toolbar = QToolBar("主工具栏")
        toolbar.setIconSize(QSize(20, 20))
        self.addToolBar(toolbar)
        style = self.style()

        def act(text, slot, icon_name=None):
            a = QAction(text, self)
            if icon_name:
                a.setIcon(style.standardIcon(getattr(QStyle, icon_name)))
            a.triggered.connect(slot)
            toolbar.addAction(a)
            return a

        self.act_back = act("上级", self.go_parent, "SP_FileDialogToParent")
        act("刷新", self.refresh, "SP_BrowserReload")
        toolbar.addSeparator()
        act("上传文件", self.upload_files, "SP_FileDialogContentsView")
        act("上传文件夹", self.upload_folder, "SP_DirIcon")
        act("下载", self.download_selected, "SP_ArrowDown")
        act("新建文件夹", self.new_folder, "SP_FileDialogNewFolder")
        act("删除", self.delete_selected, "SP_TrashIcon")
        toolbar.addSeparator()
        act("设置", self.open_settings, "SP_FileDialogListView")

        self.path_label = QLabel("位置：/")
        self.path_label.setStyleSheet("padding: 4px 8px; color: #444;")

        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(4, 4, 4, 4)
        layout.addWidget(self.path_label)

        splitter = QSplitter(Qt.Horizontal)
        layout.addWidget(splitter, 1)

        # 左侧目录树
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["目录"])
        self.tree.setMinimumWidth(220)
        self.tree.itemClicked.connect(self._on_tree_clicked)
        self.tree.itemExpanded.connect(self._on_tree_expanded)
        splitter.addWidget(self.tree)

        # 右侧文件列表
        self.table = QTreeWidget()
        self.table.setColumnCount(4)
        self.table.setHeaderLabels(["名称", "大小", "修改时间", "Key"])
        self.table.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.table.setRootIsDecorated(False)
        self.table.setAlternatingRowColors(True)
        self.table.setSortingEnabled(False)
        self.table.itemDoubleClicked.connect(self._on_table_double_clicked)
        header = self.table.header()
        header.setSectionResizeMode(COL_NAME, QHeaderView.Stretch)
        header.setSectionResizeMode(COL_SIZE, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(COL_TIME, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(COL_KEY, QHeaderView.ResizeToContents)
        splitter.addWidget(self.table)
        splitter.setStretchFactor(1, 3)

        self.statusBar().showMessage("就绪")

    # ---------- 路径与加载 ----------
    def _update_path_label(self):
        rel = self.current_dir or ""
        prefix = self.cfg.normalized_prefix()
        shown = "/" + (path_utils.join_key(prefix, rel) if rel else prefix)
        self.path_label.setText("位置：" + (shown or "/"))

    def _load_root(self):
        # 初始化树根
        self.tree.clear()
        prefix = self.cfg.normalized_prefix()
        root_name = prefix.split("/")[-1] if prefix else (self.cfg.bucket or "根目录")
        self.root_item = QTreeWidgetItem([root_name])
        self.root_item.setData(0, Qt.UserRole, "")
        self.root_item.setIcon(0, self.style().standardIcon(QStyle.SP_DirIcon))
        self.tree.addTopLevelItem(self.root_item)
        self.root_item.setExpanded(True)
        self._populate_tree_children(self.root_item, "")
        self.load_dir("")

    def _populate_tree_children(self, parent_item: QTreeWidgetItem, rel_dir: str):
        """懒加载目录子节点。"""
        try:
            dirs, _files = self.storage.list_dir(rel_dir)
        except StorageError as e:
            self.statusBar().showMessage(f"加载目录失败：{e}")
            return
        # 清理旧子节点（重复加载保护）
        parent_item.takeChildren()
        for d in dirs:
            child = QTreeWidgetItem([d.name])
            child.setData(0, Qt.UserRole, d.key)
            child.setIcon(0, self.style().standardIcon(QStyle.SP_DirIcon))
            # 占位标记，展开时再加载
            child.setData(0, Qt.UserRole + 1, False)
            parent_item.addChild(child)

    def _on_tree_expanded(self, item: QTreeWidgetItem):
        rel = item.data(0, Qt.UserRole) or ""
        if item.data(0, Qt.UserRole + 1):
            return
        self._populate_tree_children(item, rel)
        item.setData(0, Qt.UserRole + 1, True)

    def _on_tree_clicked(self, item: QTreeWidgetItem, _col):
        rel = item.data(0, Qt.UserRole)
        if rel is None:
            rel = ""
        self.load_dir(rel)

    def load_dir(self, rel_dir: str):
        self.current_dir = rel_dir or ""
        self._update_path_label()
        self.table.clear()
        try:
            dirs, files = self.storage.list_dir(self.current_dir)
        except StorageError as e:
            QMessageBox.warning(self, "加载失败", str(e))
            self.statusBar().showMessage(f"加载失败：{e}")
            return
        style = self.style()
        for d in dirs:
            item = QTreeWidgetItem([d.name, "-", "", d.key])
            item.setIcon(COL_NAME, style.standardIcon(QStyle.SP_DirIcon))
            item.setData(COL_NAME, Qt.UserRole, d.key)
            item.setData(COL_NAME, Qt.UserRole + 1, True)  # is_dir
            self.table.addTopLevelItem(item)
        for f in files:
            item = QTreeWidgetItem([f.name, _fmt_size(f.size), _fmt_time(f.last_modified), f.key])
            item.setIcon(COL_NAME, style.standardIcon(QStyle.SP_FileIcon))
            item.setData(COL_NAME, Qt.UserRole, f.key)
            item.setData(COL_NAME, Qt.UserRole + 1, False)
            self.table.addTopLevelItem(item)
        self.statusBar().showMessage(
            f"当前目录：{self.current_dir or '/'}  （{len(dirs)} 个文件夹，{len(files)} 个文件）"
        )

    def refresh(self):
        # 重载树与当前目录
        self._load_root()

    def go_parent(self):
        if not self.current_dir:
            return
        parent = path_utils.parent_key(self.current_dir)
        self.load_dir(parent)

    def _on_table_double_clicked(self, item: QTreeWidgetItem, _col):
        if item.data(COL_NAME, Qt.UserRole + 1):
            rel = item.data(COL_NAME, Qt.UserRole) or ""
            self.load_dir(rel)

    # ---------- 选中项收集 ----------
    def _selected_items(self) -> List[SelectedItem]:
        out: List[SelectedItem] = []
        for item in self.table.selectedItems():
            rel = item.data(COL_NAME, Qt.UserRole) or ""
            is_dir = bool(item.data(COL_NAME, Qt.UserRole + 1))
            out.append(SelectedItem(name=item.text(COL_NAME), is_dir=is_dir, rel_key=rel))
        return out

    # ---------- 上传 ----------
    def upload_files(self):
        files, _ = QFileDialog.getOpenFileNames(self, "选择要上传的文件（可多选）")
        if not files:
            return
        items = [SelectedItem(name=os.path.basename(f), is_dir=False, local_path=f) for f in files]
        self._start_transfer("upload", items, target_rel_dir=self.current_dir)

    def upload_folder(self):
        folder = QFileDialog.getExistingDirectory(self, "选择要上传的文件夹")
        if not folder:
            return
        items = [SelectedItem(name=os.path.basename(folder), is_dir=True, local_path=folder)]
        self._start_transfer("upload", items, target_rel_dir=self.current_dir)

    # ---------- 下载 ----------
    def download_selected(self):
        items = self._selected_items()
        if not items:
            QMessageBox.information(self, "提示", "请先在右侧选择要下载的文件或文件夹（可多选）。")
            return
        target = QFileDialog.getExistingDirectory(self, "选择下载到的本地目录")
        if not target:
            return
        self._start_transfer("download", items, target_local_dir=target)

    # ---------- 新建文件夹 ----------
    def new_folder(self):
        name, ok = QInputDialog.getText(self, "新建文件夹", "文件夹名称：")
        if not ok or not name.strip():
            return
        name = name.strip().strip("/")
        rel = path_utils.join_key(self.current_dir, name)
        try:
            self.storage.create_folder(rel)
        except StorageError as e:
            QMessageBox.warning(self, "创建失败", str(e))
            return
        self.refresh()

    # ---------- 删除 ----------
    def delete_selected(self):
        items = self._selected_items()
        if not items:
            QMessageBox.information(self, "提示", "请先选择要删除的对象。")
            return
        names = "\n".join(f"{'[目录] ' if i.is_dir else ''}{i.name}" for i in items)
        if QMessageBox.warning(
            self, "确认删除", f"将删除以下对象（目录会递归删除其下所有内容），不可恢复：\n\n{names}",
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No,
        ) != QMessageBox.Yes:
            return
        try:
            self.storage.delete([i.rel_key for i in items])
        except StorageError as e:
            QMessageBox.warning(self, "删除失败", str(e))
            return
        self.refresh()

    # ---------- 设置 ----------
    def open_settings(self):
        dlg = ConfigDialog(self.cfg, parent=self)
        if dlg.exec() == QDialog.Accepted and dlg.cfg is not None:
            self.cfg = dlg.cfg
            self.storage = StorageClient(self.cfg)
            self.setWindowTitle("青云对象存储客户端" + (f"  [{self.cfg.bucket}]" if self.cfg.bucket else ""))
            self._load_root()

    # ---------- 传输调度 ----------
    def _start_transfer(self, mode: str, items: List[SelectedItem],
                        target_local_dir: Optional[str] = None,
                        target_rel_dir: Optional[str] = None):
        if self.worker is not None and self.worker.isRunning():
            QMessageBox.information(self, "提示", "已有传输任务在进行，请等待完成或取消。")
            return
        self.worker = TransferWorker(
            mode, self.storage, items,
            target_local_dir=target_local_dir, target_rel_dir=target_rel_dir,
        )
        self.progress_dlg = QProgressDialog("准备传输…", "取消", 0, 100, self)
        self.progress_dlg.setWindowTitle("传输中" if mode == "upload" else "下载中")
        self.progress_dlg.setMinimumDuration(0)
        self.progress_dlg.setWindowModality(Qt.WindowModal)

        self.worker.progress.connect(self._on_progress)
        self.worker.log.connect(lambda m: self.statusBar().showMessage(m))
        self.worker.finished_ok.connect(self._on_transfer_done)
        self.progress_dlg.canceled.connect(self.worker.cancel)
        self.worker.start()

    def _on_progress(self, done: int, total: int, current: str):
        if self.progress_dlg is None:
            return
        if total > 0:
            pct = int(done * 100 / total)
            self.progress_dlg.setRange(0, total)
            self.progress_dlg.setValue(done)
            if self.worker and self.worker.mode == "upload":
                self.progress_dlg.setLabelText(f"上传中：{current}  ({_fmt_size(done)}/{_fmt_size(total)})")
            else:
                self.progress_dlg.setLabelText(f"下载中：{current}  ({done}/{total})")
        else:
            self.progress_dlg.setRange(0, 0)
            self.progress_dlg.setLabelText(f"传输中：{current}")

    def _on_transfer_done(self, success: bool, msg: str, count: int):
        if self.progress_dlg:
            self.progress_dlg.close()
            self.progress_dlg = None
        self.statusBar().showMessage(msg)
        if success:
            QMessageBox.information(self, "完成", msg)
            self.refresh()
        else:
            if "已取消" not in msg:
                QMessageBox.warning(self, "传输失败", msg)
            self.refresh()
