"""配置对话框：采集 endpoint / 密钥 / bucket / 前缀等，支持测试连接。"""
from __future__ import annotations

from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtWidgets import (
    QCheckBox, QDialog, QDialogButtonBox, QFormLayout, QHBoxLayout, QLabel,
    QLineEdit, QMessageBox, QPushButton, QVBoxLayout,
)

from ..config import AppConfig, ConfigManager
from ..storage import StorageClient, StorageError


class _TestWorker(QThread):
    finished_ok = Signal(bool, str)

    def __init__(self, cfg: AppConfig):
        super().__init__()
        self.cfg = cfg

    def run(self):
        try:
            client = StorageClient(self.cfg)
            ok, msg = client.test_connection()
            self.finished_ok.emit(ok, msg)
        except Exception as e:  # noqa
            self.finished_ok.emit(False, f"测试异常：{e}")


class ConfigDialog(QDialog):
    def __init__(self, cfg: AppConfig | None = None, parent=None, first_run: bool = False):
        super().__init__(parent)
        self.setWindowTitle("青云对象存储 - 配置" + ("（首次启动）" if first_run else ""))
        self.setMinimumWidth(520)
        self.cfg = cfg or AppConfig()
        self._first_run = first_run

        form = QFormLayout()

        self.endpoint = QLineEdit(self.cfg.endpoint)
        self.endpoint.setPlaceholderText("https://pek3a.qingstor.com  或  http://私有机:端口")
        form.addRow("Endpoint *", self.endpoint)

        self.access_key = QLineEdit(self.cfg.access_key)
        self.access_key.setPlaceholderText("Access Key ID")
        form.addRow("Access Key *", self.access_key)

        self.secret_key = QLineEdit(self.cfg.secret_key)
        self.secret_key.setEchoMode(QLineEdit.Password)
        self.secret_key.setPlaceholderText("Secret Access Key")
        self.secret_key.setClearButtonEnabled(True)
        form.addRow("Secret Key *", self.secret_key)

        self.bucket = QLineEdit(self.cfg.bucket)
        self.bucket.setPlaceholderText("Bucket 名称")
        form.addRow("Bucket *", self.bucket)

        self.region = QLineEdit(self.cfg.region)
        self.region.setPlaceholderText("pek3a（私有部署可留空或按文档）")
        form.addRow("Region", self.region)

        self.prefix = QLineEdit(self.cfg.prefix)
        self.prefix.setPlaceholderText("可选：子目录前缀，如  team-a/docs ，仅展示该子树下内容")
        form.addRow("子目录前缀", self.prefix)

        self.verify_ssl = QCheckBox("验证 SSL 证书（私有部署自签证书请取消勾选）")
        self.verify_ssl.setChecked(self.cfg.verify_ssl)
        form.addRow("", self.verify_ssl)

        # 测试连接
        test_row = QHBoxLayout()
        self.test_btn = QPushButton("测试连接")
        self.test_btn.clicked.connect(self._on_test)
        self.test_status = QLabel("")
        self.test_status.setStyleSheet("color: #666;")
        test_row.addWidget(self.test_btn)
        test_row.addWidget(self.test_status, 1)
        form.addRow("", test_row)

        # 按钮
        buttons = QDialogButtonBox()
        if not first_run:
            self.reset_btn = QPushButton("清除配置")
            self.reset_btn.clicked.connect(self._on_reset)
            buttons.addButton(self.reset_btn, QDialogButtonBox.ResetRole)
        self.save_btn = buttons.addButton("保存", QDialogButtonBox.AcceptRole)
        self.cancel_btn = buttons.addButton("取消", QDialogButtonBox.RejectRole)
        buttons.accepted.connect(self._on_accept)
        buttons.rejected.connect(self.reject)

        root = QVBoxLayout(self)
        if first_run:
            tip = QLabel("首次使用，请填写青云对象存储的连接信息。带 * 为必填项。")
            tip.setStyleSheet("color: #888; padding: 2px;")
            tip.setWordWrap(True)
            root.addWidget(tip)
        root.addLayout(form)
        root.addWidget(buttons)

        self._worker: _TestWorker | None = None

    # ---------- 收集配置 ----------
    def _collect(self) -> AppConfig:
        return AppConfig(
            endpoint=self.endpoint.text().strip(),
            access_key=self.access_key.text().strip(),
            secret_key=self.secret_key.text(),
            bucket=self.bucket.text().strip(),
            region=self.region.text().strip(),
            prefix=self.prefix.text().strip(),
            verify_ssl=self.verify_ssl.isChecked(),
        )

    def _on_accept(self):
        cfg = self._collect()
        missing = []
        if not cfg.endpoint:
            missing.append("Endpoint")
        if not cfg.access_key:
            missing.append("Access Key")
        if not cfg.secret_key:
            missing.append("Secret Key")
        if not cfg.bucket:
            missing.append("Bucket")
        if missing:
            QMessageBox.warning(self, "配置不完整", "以下必填项未填写：\n" + "\n".join(missing))
            return
        try:
            ConfigManager.save(cfg)
        except Exception as e:  # noqa
            QMessageBox.critical(self, "保存失败", f"无法保存配置：{e}")
            return
        self.cfg = cfg
        self.accept()

    def _on_reset(self):
        if QMessageBox.question(self, "确认", "确定清除本地配置？下次启动将重新填写。") == QMessageBox.Yes:
            ConfigManager.clear()
            self.reject()

    # ---------- 测试连接 ----------
    def _on_test(self):
        cfg = self._collect()
        if not cfg.is_complete():
            QMessageBox.information(self, "提示", "请先填写带 * 的必填项后再测试。")
            return
        self.test_btn.setEnabled(False)
        self.test_status.setText("正在测试连接…")
        self.test_status.setStyleSheet("color: #666;")
        self._worker = _TestWorker(cfg)
        self._worker.finished_ok.connect(self._on_test_result)
        self._worker.start()

    def _on_test_result(self, ok: bool, msg: str):
        self.test_btn.setEnabled(True)
        self.test_status.setText(msg)
        self.test_status.setStyleSheet("color: #2a7;" if ok else "color: #c33;")
