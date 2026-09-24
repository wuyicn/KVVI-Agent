#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 compose 文件里**读出**它需要哪些必填变量 —— 而不是在检查器里维护一份名单。

## 这个模块修的是一个反复出现的漂移

`docker-compose.kvvi.yml` 里写的是 `${KVVI_PLATFORM_DB_PASSWORD:?}` 这种
**必填插值**：变量缺失时 compose 直接报错，报错信息只说
`required variable ... is missing a value`。

于是每个要跑 `docker compose config` 的**静态**检查器，都必须喂一组占位值。
早先这件事是在每个检查器里各写一行：

    env = ('KVVI_INTERNAL_TOKEN=x KVVI_PLATFORM_DB_PASSWORD=a '
           'KVVI_BUSINESS_DB_PASSWORD=b KVVI_AUDIT_DB_PASSWORD=c')

这份名单与 compose 文件是**两份事实**。本仓库为此漂移过一次：
compose 新增 `KVVI_AUDIT_READ_DB_PASSWORD`（审计读写角色分口令）之后，
静态检查器报 `读不到 compose 配置：error while interpolating ...` ——
读起来像 compose 文件坏了，实际是检查器的名单旧了。

**修法不是「记得同步两份名单」**（那是纪律），而是让名单只有一个来源：
从 compose 文件本身扫出所有 `${VAR:?...}`。新增变量时检查器自动跟上，
不需要有人记得。

用法：

    from compose_env import placeholder_env
    cmd = placeholder_env() + ' docker compose -f ... config'
"""

import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_COMPOSE = os.path.join(ROOT, 'docker-compose.kvvi.yml')

# `${VAR:?...}` 与 `${VAR? ...}` 都算必填；`${VAR:-default}` 有默认值，不算。
_REQUIRED = re.compile(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\s*:\?')
_ALSO_REQUIRED = re.compile(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\s*\?\s*[^}]*\}')


def required_vars(compose_path: str = DEFAULT_COMPOSE) -> list:
    """compose 文件里所有**没有默认值**的插值变量名（去重、有序）。"""
    if not os.path.isfile(compose_path):
        return []
    text = open(compose_path, encoding='utf-8').read()
    names = []
    for m in _REQUIRED.finditer(text):
        if m.group(1) not in names:
            names.append(m.group(1))
    for m in _ALSO_REQUIRED.finditer(text):
        if m.group(1) not in names:
            names.append(m.group(1))
    return names


def placeholder_env(compose_path: str = DEFAULT_COMPOSE, value: str = 'static-check') -> str:
    """给 `docker compose config` 用的一串占位环境变量。

    ⚠️ 这些值是**占位**：静态检查只渲染配置，不连数据库、不做认证。
    故用同一个可辨认的字面量，而不是编几个看起来像真口令的随机串 ——
    后者会让人以为静态检查真的用过凭据。
    """
    return ' '.join('%s=%s' % (name, value) for name in required_vars(compose_path))


if __name__ == '__main__':
    for name in required_vars():
        print(name)
