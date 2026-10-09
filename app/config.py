"""应用配置管理：首次启动弹窗采集，本地持久化，敏感字段轻量混淆。"""
from __future__ import annotations

import base64
import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional


def _config_dir() -> Path:
    """配置存放目录：用户主目录下的隐藏文件夹。"""
    base = os.environ.get("QINGSTOR_CLIENT_HOME")
    if base:
        return Path(base)
    return Path.home() / ".qingstor_client"


CONFIG_PATH = _config_dir() / "config.json"


def _obfuscate(plain: str) -> str:
    """对敏感字段做可逆混淆（非加密，仅避免明文落盘）。"""
    return base64.b64encode(plain.encode("utf-8")).decode("ascii")


def _deobfuscate(value: str) -> str:
    try:
        return base64.b64decode(value.encode("ascii")).decode("utf-8")
    except Exception:
        # 兼容旧的明文配置
        return value


@dataclass
class AppConfig:
    endpoint: str = ""                # 例如 https://pek3a.qingstor.com 或私有 http://host:port
    access_key: str = ""
    secret_key: str = ""
    bucket: str = ""
    region: str = "pek3a"             # 私有部署可留空或自定义
    prefix: str = ""                  # 子目录前缀，用于隔离/只关注某子目录，形如  path/sub
    verify_ssl: bool = True           # 私有部署自签证书时可关闭

    def normalized_prefix(self) -> str:
        """规范化前缀：去除首尾斜杠，保证以目录形式存在。"""
        p = (self.prefix or "").strip().strip("/")
        return p

    def prefix_key(self) -> str:
        """用于 list 时的 Prefix 参数，空则返回空串。"""
        p = self.normalized_prefix()
        return p + "/" if p else ""

    def is_complete(self) -> bool:
        return bool(self.endpoint and self.access_key and self.secret_key and self.bucket)


class ConfigManager:
    @staticmethod
    def load() -> Optional[AppConfig]:
        if not CONFIG_PATH.exists():
            return None
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            return None
        cfg = AppConfig(
            endpoint=data.get("endpoint", ""),
            access_key=data.get("access_key", ""),
            secret_key=_deobfuscate(data.get("secret_key", "")),
            bucket=data.get("bucket", ""),
            region=data.get("region", "pek3a"),
            prefix=data.get("prefix", ""),
            verify_ssl=data.get("verify_ssl", True),
        )
        return cfg

    @staticmethod
    def save(cfg: AppConfig) -> None:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        data = asdict(cfg)
        data["secret_key"] = _obfuscate(cfg.secret_key)
        CONFIG_PATH.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    @staticmethod
    def clear() -> None:
        if CONFIG_PATH.exists():
            CONFIG_PATH.unlink()
