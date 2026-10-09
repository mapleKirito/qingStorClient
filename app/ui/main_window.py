"""主窗口：左侧目录树 + 右侧文件列表，网盘式操作。

特性：
- 目录检索在后台线程执行，加载期间显示遮罩，避免误以为卡死；
- 文件列表支持右键菜单（下载直接触发保存目录选择）；
- 上传/下载统一进入底部「传输管理」面板，后台异步、可查看进度、不阻塞主界面。
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime
from typing import Dict, List, Optional

from PySide6.QtCore import Qt, QSize, QThread, Signal
from PySide6.QtGui import QAction, QColor, QIcon, QPainter, QPalette, QPixmap
from PySide6.QtWidgets import (
    QAbstractItemView, QApplication, QDialog, QDockWidget, QFileDialog,
    QHBoxLayout, QHeaderView, QInputDialog, QLabel, QMainWindow, QMenu,
    QMessageBox, QPushButton, QSplitter, QToolBar, QTreeWidget,
    QTreeWidgetItem, QVBoxLayout, QWidget, QStyle,
)

from ..config import AppConfig
from ..storage import StorageClient, StorageError, ObjectItem
from .. import path_utils
from ..version import __version__ as VERSION, version_text
from .config_dialog import ConfigDialog
from .transfer import TransferWorker, SelectedItem
from .transfer_panel import TransferPanel


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


def _tint_icon(icon: QIcon, size: int, color: QColor) -> QIcon:
    """将单色图标统一染成指定颜色，避免标准图标在深色主题下显示为黑色。"""
    pm = icon.pixmap(size, size)
    out = QPixmap(size, size)
    out.fill(Qt.transparent)
    painter = QPainter(out)
    painter.drawPixmap(0, 0, pm)
    painter.setCompositionMode(QPainter.CompositionMode_SourceIn)
    painter.fillRect(out.rect(), color)
    painter.end()
    return QIcon(out)


def _icon_color_for(window) -> QColor:
    """根据窗口背景亮度选择图标颜色：深色背景用浅色，浅色背景用深色。"""
    bg = window.palette().color(QPalette.Window)
    luminance = 0.299 * bg.red() + 0.587 * bg.green() + 0.114 * bg.blue()
    return QColor("#f0f0f0") if luminance < 140 else QColor("#3a3a3a")


class _LoadWorker(QThread):
    """后台列举目录，避免大目录检索阻塞界面。"""
    loaded = Signal(int, str, list, list)   # seq, rel_dir, dirs, files
    failed = Signal(int, str)               # seq, message

    def __init__(self, storage: StorageClient, seq: int, rel_dir: str, parent=None):
        super().__init__(parent)
        self.storage = storage
        self.seq = seq
        self.rel_dir = rel_dir

    def run(self):
        try:
            dirs, files = self.storage.list_dir(self.rel_dir)
            self.loaded.emit(self.seq, self.rel_dir, dirs, files)
        except StorageError as e:
            self.failed.emit(self.seq, str(e))
        except Exception as e:  # noqa
            self.failed.emit(self.seq, str(e))


class MainWindow(QMainWindow):
    def __init__(self, cfg: AppConfig):
        super().__init__()
        self.cfg = cfg
        self.storage = StorageClient(cfg)
        self.current_dir: str = ""
        self._workers: Dict[str, TransferWorker] = {}
        self._load_seq = 0
        self._cursor_busy = False
        self._build_ui()
        self._load_root()

    # ---------- UI 构建 ----------
    def _build_ui(self):
        self.setWindowTitle(self._window_title())
        self.resize(1100, 720)

        toolbar = QToolBar("主工具栏")
        toolbar.setIconSize(QSize(22, 22))
        toolbar.setToolButtonStyle(Qt.ToolButtonTextBesideIcon)  # 图标 + 文字，灰色调下更清晰
        self.addToolBar(toolbar)
        style = self.style()

        def act(text, slot, icon_name=None):
            a = QAction(text, self)
            if icon_name:
                base = style.standardIcon(getattr(QStyle, icon_name))
                a.setIcon(_tint_icon(base, 22, _icon_color_for(self)))
            a.setToolTip(text)
            a.triggered.connect(slot)
            toolbar.addAction(a)
            return a

        act("上级", self.go_parent, "SP_ArrowBack")
        act("刷新", self.refresh, "SP_BrowserReload")
        toolbar.addSeparator()
        act("上传文件", self.upload_files, "SP_ArrowUp")
        act("上传文件夹", self.upload_folder, "SP_DirIcon")
        act("下载", self.download_selected, "SP_ArrowDown")
        act("新建文件夹", self.new_folder, "SP_FileDialogNewFolder")
        act("删除", self.delete_selected, "SP_TrashIcon")
        toolbar.addSeparator()
        act("设置", self.open_settings, "SP_FileDialogListView")
        toolbar.addSeparator()
        act("关于", self._show_about, "SP_DialogHelpButton")

        # 面包屑导航栏（每一级可点击快速跳转）
        self.breadcrumb = QWidget()
        self.breadcrumb.setStyleSheet("background: #f3f3f3;")
        self.bc_layout = QHBoxLayout(self.breadcrumb)
        self.bc_layout.setContentsMargins(8, 4, 8, 4)
        self.bc_layout.setSpacing(2)

        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(4, 4, 4, 4)
        layout.addWidget(self.breadcrumb)

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
        self.table.setContextMenuPolicy(Qt.CustomContextMenu)
        self.table.customContextMenuRequested.connect(self._on_context_menu)
        self.table.itemDoubleClicked.connect(self._on_table_double_clicked)
        header = self.table.header()
        header.setSectionResizeMode(COL_NAME, QHeaderView.Stretch)
        header.setSectionResizeMode(COL_SIZE, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(COL_TIME, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(COL_KEY, QHeaderView.ResizeToContents)
        splitter.addWidget(self.table)
        splitter.setStretchFactor(1, 3)

        # 加载遮罩（覆盖在文件列表上）
        self.loading_label = QLabel("正在加载目录，请稍候…", self.table.viewport())
        self.loading_label.setAlignment(Qt.AlignCenter)
        self.loading_label.setStyleSheet(
            "background-color: rgba(245,245,245,235); color:#333; "
            "font-size:15px; border:1px solid #bbb;"
        )
        self.loading_label.hide()

        # 底部传输管理面板
        self.transfer_panel = TransferPanel()
        self.transfer_panel.cancel_requested.connect(self._on_cancel_task)
        dock = QDockWidget("传输管理", self)
        dock.setWidget(self.transfer_panel)
        dock.setAllowedAreas(Qt.BottomDockWidgetArea | Qt.TopDockWidgetArea)
        self.addDockWidget(Qt.BottomDockWidgetArea, dock)
        self.transfer_dock = dock
        # 默认收起以节省空间，有任务时自动展开
        self.transfer_dock.setMaximumHeight(180)

        self.statusBar().showMessage("就绪")
        ver_label = QLabel(f"v{VERSION}")
        ver_label.setStyleSheet("color:#888; padding:0 10px;")
        self.statusBar().addPermanentWidget(ver_label)

    # ---------- 加载遮罩 ----------
    def _show_loading(self, show: bool):
        vp = self.table.viewport()
        if show:
            self.loading_label.setGeometry(0, 0, vp.width(), vp.height())
            self.loading_label.show()
            self.loading_label.raise_()
            if not self._cursor_busy:
                QApplication.setOverrideCursor(Qt.WaitCursor)
                self._cursor_busy = True
            self.statusBar().showMessage("正在加载目录…")
        else:
            self.loading_label.hide()
            if self._cursor_busy:
                QApplication.restoreOverrideCursor()
                self._cursor_busy = False

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if self.loading_label.isVisible():
            vp = self.table.viewport()
            self.loading_label.setGeometry(0, 0, vp.width(), vp.height())

    # ---------- 路径与加载 ----------
    def _rebuild_breadcrumb(self):
        """重建可点击的面包屑：根 + 当前目录每一级，点击即跳转。"""
        while self.bc_layout.count():
            it = self.bc_layout.takeAt(0)
            w = it.widget()
            if w is not None:
                w.deleteLater()

        prefix = self.cfg.normalized_prefix()
        root_name = prefix.split("/")[-1] if prefix else (self.cfg.bucket or "根目录")
        self._add_crumb(root_name, "")
        segs = path_utils.split_key(self.current_dir or "")
        for i, seg in enumerate(segs):
            sep = QLabel("/")
            sep.setStyleSheet("color:#999; padding:0 1px;")
            self.bc_layout.addWidget(sep)
            self._add_crumb(seg, "/".join(segs[: i + 1]))
        self.bc_layout.addStretch(1)

    def _add_crumb(self, text: str, rel_dir: str):
        btn = QPushButton(text)
        btn.setFlat(True)
        btn.setCursor(Qt.PointingHandCursor)
        btn.setStyleSheet(
            "QPushButton{color:#1a6fb0; border:none; padding:2px 4px; font-weight:bold;}"
            "QPushButton:hover{text-decoration:underline; background:#e6e6e6;}"
        )
        btn.clicked.connect(lambda _checked=False, r=rel_dir: self.load_dir(r))
        self.bc_layout.addWidget(btn)

    def _load_root(self):
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
        """懒加载目录子节点（同步，子目录数量通常可控）。"""
        try:
            dirs, _files = self.storage.list_dir(rel_dir)
        except StorageError as e:
            self.statusBar().showMessage(f"加载目录失败：{e}")
            return
        parent_item.takeChildren()
        for d in dirs:
            child = QTreeWidgetItem([d.name])
            child.setData(0, Qt.UserRole, d.key)
            child.setIcon(0, self.style().standardIcon(QStyle.SP_DirIcon))
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
        """异步加载目录：后台列举 + 遮罩提示。"""
        self.current_dir = rel_dir or ""
        self._rebuild_breadcrumb()
        self.table.clear()
        self._show_loading(True)
        self._load_seq += 1
        seq = self._load_seq
        worker = _LoadWorker(self.storage, seq, self.current_dir, parent=self)
        worker.loaded.connect(self._on_dir_loaded)
        worker.failed.connect(self._on_dir_failed)
        worker.finished.connect(worker.deleteLater)
        worker.start()

    def _on_dir_loaded(self, seq: int, rel_dir: str, dirs: list, files: list):
        if seq != self._load_seq:
            return  # 过期结果（用户已切换到更新目录）
        self._show_loading(False)
        style = self.style()
        dir_icon = style.standardIcon(QStyle.SP_DirIcon)

        # 顶部强制添加 . 与 ..（类 Linux 风格）
        dot = QTreeWidgetItem([".", "", "", ""])
        dot.setIcon(COL_NAME, dir_icon)
        dot.setData(COL_NAME, Qt.UserRole + 2, ".")
        self.table.addTopLevelItem(dot)
        dotdot = QTreeWidgetItem(["..", "", "", ""])
        dotdot.setIcon(COL_NAME, dir_icon)
        dotdot.setData(COL_NAME, Qt.UserRole + 2, "..")
        self.table.addTopLevelItem(dotdot)

        for d in dirs:
            item = QTreeWidgetItem([d.name, "-", "", d.key])
            item.setIcon(COL_NAME, style.standardIcon(QStyle.SP_DirIcon))
            item.setData(COL_NAME, Qt.UserRole, d.key)
            item.setData(COL_NAME, Qt.UserRole + 1, True)
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

    def _on_dir_failed(self, seq: int, msg: str):
        if seq != self._load_seq:
            return
        self._show_loading(False)
        self.statusBar().showMessage(f"加载失败：{msg}")

    def refresh(self):
        self._load_root()

    def go_parent(self):
        if not self.current_dir:
            return
        self.load_dir(path_utils.parent_key(self.current_dir))

    def _on_table_double_clicked(self, item: QTreeWidgetItem, _col):
        kind = item.data(COL_NAME, Qt.UserRole + 2)
        if kind == ".":
            self.load_dir(self.current_dir)  # 刷新当前目录
            return
        if kind == "..":
            self.go_parent()
            return
        if item.data(COL_NAME, Qt.UserRole + 1):
            rel = item.data(COL_NAME, Qt.UserRole) or ""
            self.load_dir(rel)

    # ---------- 右键菜单 ----------
    def _on_context_menu(self, pos):
        item = self.table.itemAt(pos)
        if item is not None and not item.isSelected():
            self.table.setCurrentItem(item)
        selected = self._selected_items()
        menu = QMenu(self)
        act_dl = menu.addAction("下载…")
        act_dl.setEnabled(bool(selected))
        menu.addSeparator()
        act_del = menu.addAction("删除")
        act_del.setEnabled(bool(selected))
        act_ref = menu.addAction("刷新")
        chosen = menu.exec(self.table.viewport().mapToGlobal(pos))
        if chosen is act_dl and selected:
            self._do_download(selected)
        elif chosen is act_del:
            self.delete_selected()
        elif chosen is act_ref:
            self.refresh()

    # ---------- 选中项收集 ----------
    def _selected_items(self) -> List[SelectedItem]:
        out: List[SelectedItem] = []
        for item in self.table.selectedItems():
            kind = item.data(COL_NAME, Qt.UserRole + 2)
            if kind in (".", ".."):
                continue  # 排除 . 与 ..，不参与下载/删除
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
        self._do_download(items)

    def _do_download(self, items: List[SelectedItem]):
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
            self.setWindowTitle(self._window_title())
            self._load_root()

    def _window_title(self) -> str:
        suffix = f"  [{self.cfg.bucket}]" if self.cfg.bucket else ""
        return f"青云对象存储客户端 v{VERSION}{suffix}"

    def _show_about(self):
        QMessageBox.information(self, "关于", version_text())

    # ---------- 传输调度（非阻塞） ----------
    def _start_transfer(self, mode: str, items: List[SelectedItem],
                        target_local_dir: Optional[str] = None,
                        target_rel_dir: Optional[str] = None):
        task_id = uuid.uuid4().hex
        if mode == "upload":
            where = target_rel_dir or "/"
            title = f"上传 → {where}（{len(items)} 项）"
        else:
            names = "、".join(i.name for i in items[:3])
            if len(items) > 3:
                names += f" 等{len(items)}项"
            title = f"下载 ← {names}"

        is_bytes = (mode == "upload")
        self.transfer_panel.start_task(task_id, title, is_bytes)
        self.transfer_dock.show()
        self.transfer_dock.raise_()

        worker = TransferWorker(
            mode, self.storage, items,
            target_local_dir=target_local_dir, target_rel_dir=target_rel_dir,
        )
        self._workers[task_id] = worker

        worker.progress.connect(
            lambda d, t, c, tid=task_id: self.transfer_panel.update_progress(tid, d, t, c))
        worker.log.connect(lambda m, tid=task_id: self.statusBar().showMessage(m))
        worker.finished_ok.connect(
            lambda ok, msg, cnt, tid=task_id: self._on_task_done(tid, ok, msg, cnt))
        worker.finished.connect(lambda tid=task_id: self._cleanup_worker(tid))
        worker.start()

    def _on_cancel_task(self, task_id: str):
        worker = self._workers.get(task_id)
        if worker is not None:
            worker.cancel()

    def _on_task_done(self, task_id: str, success: bool, msg: str, count: int):
        self.transfer_panel.finish_task(task_id, success, msg)
        self.statusBar().showMessage(msg)
        # 传输结束后刷新当前目录（新增/删除了文件）
        self.load_dir(self.current_dir)

    def _cleanup_worker(self, task_id: str):
        worker = self._workers.pop(task_id, None)
        if worker is not None:
            worker.deleteLater()
