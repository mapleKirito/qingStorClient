"""青云对象存储客户端封装（基于 boto3 S3 兼容协议）。

所有 public 方法接收的 ``rel`` / ``rel_key`` / ``rel_dir`` 均为**相对配置前缀**的路径，
内部自动拼接 prefix，UI 层无需感知前缀隔离细节。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional, Tuple

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError, EndpointConnectionError, NoCredentialsError

from .config import AppConfig
from . import path_utils


@dataclass
class ObjectItem:
    key: str            # 相对 prefix 的 key（不含前导斜杠）
    name: str           # 显示名（末段）
    size: int           # 字节，目录为 0
    is_dir: bool
    last_modified: Optional[datetime] = None

    @property
    def parent(self) -> str:
        return path_utils.parent_key(self.key)


class StorageError(Exception):
    pass


class StorageClient:
    def __init__(self, cfg: AppConfig):
        self.cfg = cfg
        self._client = None

    # ---------- 连接 ----------
    def _build_client(self):
        if self._client is not None:
            return self._client
        if not self.cfg.is_complete():
            raise StorageError("配置不完整，请先填写 endpoint / access_key / secret_key / bucket")
        kwargs = dict(
            service_name="s3",
            endpoint_url=self.cfg.endpoint.rstrip("/"),
            aws_access_key_id=self.cfg.access_key,
            aws_secret_access_key=self.cfg.secret_key,
            config=Config(
                s3={"addressing_style": "path"},
                signature_version="s3v4",
                connect_timeout=10,
                read_timeout=30,
                retries={"max_attempts": 1},
            ),
        )
        if self.cfg.region:
            kwargs["region_name"] = self.cfg.region
        if not self.cfg.verify_ssl:
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            kwargs["verify"] = False
        self._client = boto3.client(**kwargs)
        return self._client

    @property
    def client(self):
        return self._build_client()

    def reset(self):
        self._client = None

    def test_connection(self) -> Tuple[bool, str]:
        """测试连接与 bucket 可访问性。"""
        try:
            c = self._build_client()
            c.head_bucket(Bucket=self.cfg.bucket)
            return True, "连接成功，Bucket 可访问"
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            msg = e.response.get("Error", {}).get("Message", str(e))
            if code in ("403", "AccessDenied"):
                return False, f"访问被拒绝（403）：{msg}。请检查密钥权限与 bucket 名称。"
            if code in ("404", "NoSuchBucket"):
                return False, f"Bucket 不存在（404）：{msg}。请检查 bucket 名称与 endpoint/region。"
            return False, f"连接失败：{code} {msg}"
        except EndpointConnectionError:
            return False, "无法连接到 endpoint，请检查地址与网络。"
        except NoCredentialsError:
            return False, "缺少凭证。"
        except Exception as e:  # noqa
            return False, f"连接异常：{e}"

    # ---------- key 前缀辅助 ----------
    def _abs(self, rel: str) -> str:
        """相对路径 -> 带 prefix 的绝对 key。"""
        return path_utils.add_prefix(rel or "", self.cfg.prefix)

    def _rel(self, abs_key: str) -> str:
        """绝对 key -> 相对 prefix 的路径。"""
        return path_utils.strip_prefix(abs_key, self.cfg.prefix)

    def _list_prefix_for(self, rel_dir: str) -> str:
        """列举某目录时使用的 Prefix（带末尾斜杠）。"""
        abs_dir = self._abs(rel_dir or "")
        return abs_dir + "/" if abs_dir else ""

    # ---------- 列举 ----------
    def list_dir(self, rel_dir: str = "") -> Tuple[List[ObjectItem], List[ObjectItem]]:
        """列举目录，返回 (子目录列表, 文件列表)。rel_dir 相对 prefix。"""
        c = self.client
        list_prefix = self._list_prefix_for(rel_dir)
        dirs: List[ObjectItem] = []
        files: List[ObjectItem] = []
        token: Optional[str] = None
        while True:
            kwargs = dict(Bucket=self.cfg.bucket, Delimiter="/")
            if list_prefix:
                kwargs["Prefix"] = list_prefix
            if token:
                kwargs["ContinuationToken"] = token
            try:
                resp = c.list_objects_v2(**kwargs)
            except ClientError as e:
                raise StorageError(f"列举失败：{e.response.get('Error', {}).get('Message', e)}")
            for cp in resp.get("CommonPrefixes", []):
                abs_p = cp["Prefix"]
                rel = self._rel(abs_p).rstrip("/")
                if rel:
                    dirs.append(ObjectItem(key=rel, name=path_utils.basename(rel),
                                           size=0, is_dir=True))
            for obj in resp.get("Contents", []):
                abs_k = obj["Key"]
                rel = self._rel(abs_k)
                # 过滤掉当前目录占位对象自身（如 list_prefix 精确匹配的空对象）
                if not rel or rel == list_prefix.rstrip("/"):
                    continue
                # 跳过模拟目录的占位对象（以 / 结尾）
                if abs_k.endswith("/"):
                    continue
                name = path_utils.basename(rel)
                if name:
                    files.append(ObjectItem(
                        key=rel, name=name, size=obj.get("Size", 0),
                        is_dir=False, last_modified=obj.get("LastModified"),
                    ))
            if resp.get("IsTruncated"):
                token = resp.get("NextContinuationToken")
                if not token:
                    break
            else:
                break
        dirs.sort(key=lambda x: x.name.lower())
        files.sort(key=lambda x: x.name.lower())
        return dirs, files

    def list_all_files(self, rel_dir: str = "") -> List[str]:
        """递归列出 rel_dir 下所有文件的相对 key（不含目录占位）。"""
        c = self.client
        base = self._list_prefix_for(rel_dir)
        keys: List[str] = []
        token: Optional[str] = None
        while True:
            kwargs = dict(Bucket=self.cfg.bucket)
            if base:
                kwargs["Prefix"] = base
            if token:
                kwargs["ContinuationToken"] = token
            resp = c.list_objects_v2(**kwargs)
            for obj in resp.get("Contents", []):
                abs_k = obj["Key"]
                if abs_k.endswith("/"):
                    continue
                rel = self._rel(abs_k)
                if rel:
                    keys.append(rel)
            if resp.get("IsTruncated"):
                token = resp.get("NextContinuationToken")
                if not token:
                    break
            else:
                break
        return keys

    # ---------- 上传 / 下载 ----------
    def upload_file(self, local_path: str, rel_key: str, callback=None) -> None:
        abs_key = self._abs(rel_key)
        c = self.client
        try:
            c.upload_file(Filename=local_path, Bucket=self.cfg.bucket, Key=abs_key,
                          Callback=callback)
        except ClientError as e:
            raise StorageError(f"上传失败：{e.response.get('Error', {}).get('Message', e)}")

    def download_file(self, rel_key: str, local_path: str, callback=None) -> None:
        abs_key = self._abs(rel_key)
        os.makedirs(os.path.dirname(os.path.abspath(local_path)), exist_ok=True)
        c = self.client
        try:
            c.download_file(Bucket=self.cfg.bucket, Key=abs_key, Filename=local_path,
                            Callback=callback)
        except ClientError as e:
            raise StorageError(f"下载失败：{e.response.get('Error', {}).get('Message', e)}")

    def create_folder(self, rel_dir: str) -> None:
        """创建模拟目录：上传一个以 '/' 结尾的 0 字节占位对象。"""
        abs_key = self._abs(rel_dir).rstrip("/") + "/"
        if not abs_key.strip("/"):
            return
        c = self.client
        try:
            c.put_object(Bucket=self.cfg.bucket, Key=abs_key, Body=b"")
        except ClientError as e:
            raise StorageError(f"创建目录失败：{e.response.get('Error', {}).get('Message', e)}")

    def delete(self, rel_keys: List[str]) -> None:
        """批量删除对象（含目录占位会一并清理该目录下所有内容）。"""
        if not rel_keys:
            return
        c = self.client
        # 展开目录为其下全部对象
        abs_keys: List[str] = []
        for rk in rel_keys:
            # 判断是否为目录：先看是否有以 rk/ 为前缀的对象
            sub = self.list_all_files(rk) if rk else []
            if sub:
                for s in sub:
                    abs_keys.append(self._abs(s))
                # 目录占位对象
                abs_keys.append(self._abs(rk).rstrip("/") + "/")
            else:
                abs_keys.append(self._abs(rk))
        # 去重
        abs_keys = list(dict.fromkeys(abs_keys))
        # 批量删除，每次最多 1000
        for i in range(0, len(abs_keys), 1000):
            batch = [{"Key": k} for k in abs_keys[i:i + 1000]]
            try:
                c.delete_objects(Bucket=self.cfg.bucket, Delete={"Objects": batch, "Quiet": True})
            except ClientError as e:
                raise StorageError(f"删除失败：{e.response.get('Error', {}).get('Message', e)}")

    def object_exists(self, rel_key: str) -> bool:
        abs_key = self._abs(rel_key)
        try:
            self.client.head_object(Bucket=self.cfg.bucket, Key=abs_key)
            return True
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey"):
                return False
            raise StorageError(str(e))
