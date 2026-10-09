"""对象存储 key 与本地文件系统路径之间的安全转换。

核心问题：
1. 对象存储的 key 可包含任意字符（以 '/' 模拟目录层级）；
2. 本地（尤其 Windows）文件/目录名不允许 ``\\ / : * ? " < > |`` 及控制字符，
   也不允许以空格或点结尾，且有 CON/PRN/NUL 等保留名；
3. 需要在两者之间做**可逆**映射，保证上传/下载来回不丢失信息。

策略：对单个路径段（key 中两个 '/' 之间的部分，或本地一个文件/目录名）
做百分号编码：先编码 '%'，再编码对本地不安全的字符，还原时唯一解码。

编码按平台自适应：
- Windows：严格规则，编码非法字符、结尾空格/点、保留名；
- macOS / Linux：宽松规则，仅编码 '%' 与 NUL，尽量保留原生文件名显示。
解码侧始终统一，因此任一平台下载的文件都能正确还原为远程 key。
"""
from __future__ import annotations

import re
import sys
from typing import List, Optional, Tuple


def _is_windows() -> bool:
    return sys.platform.startswith("win")

# Windows 文件名中不允许的字符（'/' 作为分隔符不在此列，单独处理）
_UNSAFE_CHARS = set('\\/:*?"<>|')
# 控制字符
_CONTROL_CHARS = set(chr(i) for i in range(0x20))
# 结尾不允许空格或点
_TRAILING_BAD = re.compile(r"[ .]+$")
# Windows 保留设备名
_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def _is_reserved(name: str) -> bool:
    base = name.split(".", 1)[0].upper()
    return base in _RESERVED


def _encode_segment(seg: str, strict: Optional[bool] = None) -> str:
    """将对象存储的单个 key 段编码为本地安全文件名（可逆）。

    strict=True  Windows 严格规则；strict=False  POSIX 宽松规则；
    strict=None  按当前平台自动选择。解码侧始终统一，不受此影响。
    """
    if seg == "":
        return seg
    if strict is None:
        strict = _is_windows()

    if not strict:
        # POSIX (macOS / Linux)：文件名几乎任意，仅 NUL 与转义符 '%' 需编码
        out = []
        for ch in seg:
            if ch == "%":
                out.append("%25")
            elif ord(ch) == 0:
                out.append("%00")
            else:
                out.append(ch)
        return "".join(out)

    # Windows 严格规则
    out = []
    for ch in seg:
        if ch == "%":
            out.append("%25")
        elif ch in _UNSAFE_CHARS or ch in _CONTROL_CHARS:
            out.append(f"%{ord(ch):02X}")
        else:
            out.append(ch)
    encoded = "".join(out)
    # 处理结尾空格/点：编码最后一个字符
    m = _TRAILING_BAD.search(encoded)
    if m:
        encoded = encoded[: m.start()] + "".join(
            f"%{ord(c):02X}" for c in m.group()
        )
    # 处理保留名：编码首字符，使其不再是保留名且可逆
    if _is_reserved(encoded) and encoded:
        encoded = f"%{ord(encoded[0]):02X}" + encoded[1:]
    return encoded


def _decode_segment(seg: str) -> str:
    """将本地安全文件名还原为对象存储 key 段（平台无关，统一解码）。"""

    def repl(m: "re.Match") -> str:
        return chr(int(m.group(1), 16))

    return re.sub(r"%([0-9A-Fa-f]{2})", repl, seg)


def encode_for_local(segment: str, strict: Optional[bool] = None) -> str:
    return _encode_segment(segment, strict)


def decode_from_local(segment: str) -> str:
    return _decode_segment(segment)


# ---------- key 与路径拼接 ----------

def join_key(*parts: str) -> str:
    """用 '/' 拼接 key 段，自动去掉空段与多余斜杠。"""
    cleaned: List[str] = []
    for p in parts:
        if p is None:
            continue
        for seg in str(p).split("/"):
            if seg != "":
                cleaned.append(seg)
    return "/".join(cleaned)


def split_key(key: str) -> List[str]:
    return [s for s in key.split("/") if s != ""]


def parent_key(key: str) -> str:
    """返回父目录 key（不含末尾斜杠），根则返回空串。"""
    parts = split_key(key)
    if not parts:
        return ""
    return "/".join(parts[:-1])


def basename(key: str) -> str:
    parts = split_key(key)
    return parts[-1] if parts else ""


def strip_prefix(key: str, prefix: str) -> str:
    """从 key 中去掉前缀，返回相对路径。"""
    p = prefix.strip("/")
    if p and key.startswith(p + "/"):
        return key[len(p) + 1:]
    if p and key == p:
        return ""
    return key


def add_prefix(rel: str, prefix: str) -> str:
    p = prefix.strip("/")
    rel = rel.strip("/")
    return join_key(p, rel) if p else rel


def key_to_local_path(key: str, prefix: str, local_root: str) -> str:
    """将对象 key（相对 prefix）映射到本地目录下的安全路径。

    key 应为相对 prefix 的路径；返回本地绝对/相对路径字符串。
    """
    import os
    parts = split_key(key)
    safe_parts = [_encode_segment(p) for p in parts]
    return os.path.join(local_root, *safe_parts) if safe_parts else local_root


def local_path_to_key(local_path: str, local_root: str, prefix: str) -> str:
    """将本地路径（在 local_root 之下）映射回对象 key（含 prefix）。"""
    import os
    rel = os.path.relpath(local_path, local_root)
    # rel 在 Windows 上用 '\\'，统一处理
    segs = re.split(r"[\\/]", rel)
    decoded = [_decode_segment(s) for s in segs if s and s != "."]
    return add_prefix("/".join(decoded), prefix)
