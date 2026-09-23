#!/usr/bin/env python3
"""KVVI Agent PRD 第二轮评审 — DeepSeek 前沿模型运行器。

第一轮该视角由 deepseek-r1:32b（本地 32B）承担，但它在本次任务上
编造了两个不存在的问题（见 汇总.md 第三节）。本运行器改用 deepseek-v4-pro
重做同一视角，以判断「问题出在模型规模还是模型家族」。

密钥从 ~/.dsh/.credentials.yaml 读取，不打印、不落盘。

用法：
    python3 run_deepseek_review.py <视角标识> <输出文件名>
"""
import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PRD = ROOT / 'KVVI-Agent 开发文档 PRD.md'
ENDPOINT = 'https://api.deepseek.com/chat/completions'
MODEL = 'deepseek-v4-pro'

DISCIPLINE = """【评审纪律】

1. 你的职责是**找出真实存在的问题**，不是确认这份 PRD 写得好。若通篇赞美，本次评审即失败。
2. 每条结论必须**引用 PRD 中的具体内容**（章节号或原文片段）。泛泛而谈不计入。
3. **没有把握就明说「未发现」**。编造的问题比漏掉问题更糟——上一轮评审中有模型声称
   「§5.5 未包含 money 类型」，而 `money` 就在该节字段列表里；另称「§3.3 未处理未提交单据」，
   而该节有整行「草稿（未提交）｜归档封存」。此类错误会直接导致误改。
4. 不要重写 PRD、不要提出范围外的产品设想，只指出问题与改法。
5. 判断依据只能是这份 PRD 本身。它引用的外部项目（KVVI-Builder、DeepSeek Harness）
   你无法查阅；若某处判断依赖外部资料，请标注「依赖外部资料，无法核实」。

【输出格式】

先给一句总体判断（不超过 60 字），然后：

## 阻断（必须修，否则不能开工）
### 1. <一句话概括>
- **位置**：§<章节号>
- **原文**：<引用或转述>
- **问题**：<为什么是问题>
- **建议**：<怎么改>

## 重要（应修）
（同结构）

## 建议（可选）
（同结构）

## 覆盖范围自述
<列出你检查过但认为没问题的方面>
"""


def build_prompt(prd_text: str, lens: str) -> str:
    return f"""你是 KVVI Agent 项目的**独立评审人**。你与项目团队没有沟通渠道，
只依据下面这份 PRD 全文作出判断，独立完成，不假设他人已审过。

【本次评审视角】
{lens}

{DISCIPLINE}

════════════════════════════════════════════════════════
以下是 PRD 全文（KVVI Agent 产品需求文档 v2.9）
════════════════════════════════════════════════════════

{prd_text}
"""


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    lens_id, out_name = sys.argv[1], sys.argv[2]

    lenses = json.loads((HERE / 'lenses.json').read_text(encoding='utf-8'))
    if lens_id not in lenses:
        print(f'未知视角 {lens_id}；可选：{[k for k in lenses if not k.startswith("_")]}')
        return 2
    lens = lenses[lens_id]

    key = yaml.safe_load(
        (Path.home() / '.dsh' / '.credentials.yaml').read_text(encoding='utf-8'))['DEEPSEEK_API_KEY']

    prd_text = PRD.read_text(encoding='utf-8')
    prompt = build_prompt(prd_text, lens)
    prompt_digest = hashlib.sha256(prompt.encode('utf-8')).hexdigest()

    print(f'[{MODEL}] 视角={lens_id}')
    print(f'[{MODEL}] PRD {len(prd_text)} 字符 / prompt {len(prompt)} 字符')
    print(f'[{MODEL}] prompt sha256 {prompt_digest[:16]}…')

    payload = {
        'model': MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        'temperature': 0.3,
        'stream': False,
    }
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'},
    )
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=1800) as response:
            body = json.loads(response.read().decode('utf-8'))
    except Exception as error:  # noqa: BLE001 - 外部 API 的失败形态多样，统一记录后退出
        print(f'[{MODEL}] 调用失败：{type(error).__name__}: {str(error)[:200]}')
        return 1
    elapsed = time.time() - started

    answer = body.get('choices', [{}])[0].get('message', {}).get('content', '')
    usage = body.get('usage', {})

    (HERE / '证据' / f'{out_name}.md').write_text(answer, encoding='utf-8')
    record = {
        'runner': 'deepseek-api',
        'model': MODEL,
        'family': 'deepseek',
        'lens': lens_id,
        'prd_sha256': hashlib.sha256(prd_text.encode('utf-8')).hexdigest(),
        'prompt_sha256': prompt_digest,
        'answer_sha256': hashlib.sha256(answer.encode('utf-8')).hexdigest(),
        'answer_chars': len(answer),
        'elapsed_seconds': round(elapsed, 1),
        'usage': usage,
    }
    (HERE / '证据' / f'{out_name}.record.json').write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print(f'[{MODEL}] 完成：{len(answer)} 字符，耗时 {elapsed:.0f} 秒，tokens={usage.get("total_tokens", "?")}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
