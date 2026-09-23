"""Deterministic diagnostics for the Python Meta-Schema implementation."""

from __future__ import annotations

import re
import json
from typing import Iterable


MESSAGES = {
    "SECRET_DETECTED": ("草案含疑似秘密信息", "移除秘密值，由受控密钥管理提供"),
    "PERMISSION_DECLARATION_FORBIDDEN": ("业务正文不得直接声明授权或可信身份", "移除注入声明，通过独立权限契约和可信上下文处理"),
    "UNKNOWN_PROPERTY": ("出现未登记属性", "移除未登记属性"),
    "CONTRACT_VERSION_UNSUPPORTED": ("契约版本不受支持", "使用受支持的固定契约版本"),
    "CONTRACT_SHAPE_INVALID": ("契约结构不合法", "按所选入口修正契约结构"),
    "REFERENCE_INVALID": ("资源引用结构不合法", "提供完整且固定版本的资源引用"),
    "VIEW_CAPABILITY_REF_INVALID": ("能力引用结构不合法", "提供完整且固定版本的能力引用"),
    "DEPENDENCY_VALIDATOR_UNAVAILABLE": ("依赖协议校验器尚不可用", "等待对应协议校验器实现后重试"),
    "TRUSTED_CONTEXT_REQUIRED": ("完整校验需要独立可信上下文", "提供受信任的固定测试上下文"),
}


def diagnostic(code: str, path: str) -> dict[str, str]:
    message, suggested_fix = MESSAGES.get(
        code, ("契约校验失败", "根据错误码修正输入后重试")
    )
    return {
        "code": code,
        "severity": "ERROR",
        "path": path or "$",
        "message": message,
        "suggested_fix": suggested_fix,
    }


def sorted_unique(errors: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    unique = {
        (item["path"].encode("utf-8"), item["code"]): item for item in errors
    }
    return [unique[key] for key in sorted(unique)]


def join_path(parts: Iterable[object], view: bool = False) -> str:
    result = ""
    dynamic = 0
    for part in parts:
        if isinstance(part, int):
            result += f"[{part}]"
        elif not dynamic and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(part)):
            result += ("" if not result else ".") + str(part)
        else:
            result += '[' + json.dumps(str(part), ensure_ascii=False) + ']'
        dynamic = max(0, dynamic - 1)
        if view and part in ("props", "actions", "input", "params"):
            dynamic = 1
        elif view and part == "i18n":
            dynamic = 2
    return result or "$"
