"""传输后台线程：上传/下载，支持文件夹递归、多选、字节级进度。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import List, Optional, Tuple

from PySide6.QtCore import QThread, Signal

from ..storage import StorageClient, StorageError
from .. import path_utils


@dataclass
class SelectedItem:
    """UI 选中项：上传时填 local_path；下载时填 rel_key。"""
    name: str
    is_dir: bool
    local_path: Optional[str] = None   # 上传用：本地绝对路径
    rel_key: Optional[str] = None      # 下载用：远程相对 key


class TransferWorker(QThread):
    # done_bytes, total_bytes, current_name
    progress = Signal(int, int, str)
    log = Signal(str)
    # success, message, transferred_count
    finished_ok = Signal(bool, str, int)

    def __init__(self, mode: str, client: StorageClient, items: List[SelectedItem],
                 target_local_dir: Optional[str] = None,
                 target_rel_dir: Optional[str] = None):
        """
        mode: 'upload' 或 'download'
        upload:   items 含 local_path；target_rel_dir 为远程目标目录（相对 prefix）
        download: items 含 rel_key；   target_local_dir 为本地目标目录
        """
        super().__init__()
        self.mode = mode
        self.client = client
        self.items = items
        self.target_local_dir = target_local_dir
        self.target_rel_dir = target_rel_dir
        self._cancelled = False

    def cancel(self):
        self._cancelled = True

    # ---------- 主流程 ----------
    def run(self):
        try:
            if self.mode == "upload":
                tasks, total = self._enumerate_upload()
                self._execute_upload(tasks, total)
            else:
                tasks, total = self._enumerate_download()
                self._execute_download(tasks, total)
        except StorageError as e:
            self.finished_ok.emit(False, str(e), 0)
        except Exception as e:  # noqa
            self.finished_ok.emit(False, f"传输异常：{e}", 0)

    # ---------- 上传枚举 ----------
    def _enumerate_upload(self) -> Tuple[List[Tuple[str, str]], int]:
        """返回 [(local_path, rel_key), ...] 与总字节数。"""
        tasks: List[Tuple[str, str]] = []
        total = 0
        base_rel = (self.target_rel_dir or "").strip("/")
        for item in self.items:
            if not item.local_path or not os.path.exists(item.local_path):
                self.log.emit(f"跳过（不存在）：{item.local_path}")
                continue
            if os.path.isdir(item.local_path):
                folder_name = os.path.basename(os.path.normpath(item.local_path))
                # 远程目录段用本地名解码（还原可能的 %XX）
                remote_folder = path_utils.decode_from_local(folder_name)
                for root, _dirs, files in os.walk(item.local_path):
                    for fn in files:
                        lp = os.path.join(root, fn)
                        rel_inside = os.path.relpath(lp, item.local_path)
                        segs = re_split(rel_inside)
                        decoded_segs = [path_utils.decode_from_local(s) for s in segs]
                        rel_key = path_utils.join_key(base_rel, remote_folder, *decoded_segs)
                        tasks.append((lp, rel_key))
                        try:
                            total += os.path.getsize(lp)
                        except OSError:
                            pass
            else:
                fn = os.path.basename(item.local_path)
                remote_name = path_utils.decode_from_local(fn)
                rel_key = path_utils.join_key(base_rel, remote_name)
                tasks.append((item.local_path, rel_key))
                try:
                    total += os.path.getsize(item.local_path)
                except OSError:
                    pass
        return tasks, total

    def _execute_upload(self, tasks, total_bytes):
        done = 0
        count = 0
        for local_path, rel_key in tasks:
            if self._cancelled:
                self.finished_ok.emit(False, "已取消", count)
                return
            name = path_utils.basename(rel_key)
            self.log.emit(f"上传：{name}")

            def cb(bytes_sent, _lp=local_path, _rk=rel_key, _nm=name):
                nonlocal done
                done += bytes_sent
                self.progress.emit(done, total_bytes, _nm)

            # 记录起始已计大小，避免与 walk 统计重复累加差异：这里 cb 每次传增量，OK
            self.client.upload_file(local_path, rel_key, callback=cb)
            count += 1
        self.finished_ok.emit(True, f"上传完成，共 {count} 个文件", count)

    # ---------- 下载枚举 ----------
    def _enumerate_download(self) -> Tuple[List[Tuple[str, str]], int]:
        """返回 [(rel_key, local_path), ...] 与总字节数（远程大小未知时为 0）。"""
        tasks: List[Tuple[str, str]] = []
        assert self.target_local_dir
        local_root = self.target_local_dir
        for item in self.items:
            if item.is_dir:
                # 递归列出该目录下所有文件
                files = self.client.list_all_files(item.rel_key or "")
                folder_name = path_utils.basename(item.rel_key) if item.rel_key else ""
                safe_folder = path_utils.encode_for_local(folder_name) if folder_name else ""
                base_local = os.path.join(local_root, safe_folder) if safe_folder else local_root
                for rk in files:
                    # 相对 item.rel_key 的子路径
                    sub = path_utils.strip_prefix(rk, item.rel_key or "")
                    local_path = path_utils.key_to_local_path(sub, "", base_local)
                    tasks.append((rk, local_path))
            else:
                name = path_utils.basename(item.rel_key)
                safe_name = path_utils.encode_for_local(name)
                local_path = os.path.join(local_root, safe_name)
                tasks.append((item.rel_key, local_path))
        return tasks, 0  # 远程总大小未提前统计，进度按文件数

    def _execute_download(self, tasks, _total):
        done = 0
        count = 0
        total = len(tasks)
        for rel_key, local_path in tasks:
            if self._cancelled:
                self.finished_ok.emit(False, "已取消", count)
                return
            name = path_utils.basename(rel_key)
            self.log.emit(f"下载：{name}")
            self.client.download_file(rel_key, local_path)
            count += 1
            done += 1
            self.progress.emit(done, total, name)
        self.finished_ok.emit(True, f"下载完成，共 {count} 个文件", count)


def re_split(path: str) -> List[str]:
    import re
    return [s for s in re.split(r"[\\/]", path) if s and s != "."]
