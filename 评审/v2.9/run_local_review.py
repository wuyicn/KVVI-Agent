#!/usr/bin/env python3
"""KVVI Agent PRD v2.1 独立评审运行器。

用途：把同一份 PRD 全文分别交给多个本地模型，各自按指定的评审视角独立作答。
独立性由调用方保证——每个模型只看到 PRD 与自己的评审视角，看不到其他模型的结论。

用法：
    python3 run_review.py <模型名> <视角标识> <输出文件名>
"""
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
PRD = ROOT / 'KVVI-Agent 开发文档 PRD.md'
OLLAMA = 'http://127.0.0.1:11434/api/chat'

# 评审纪律：要求挑问题、要求引用原文、禁止编造、禁止重写 PRD。
DISCIPLINE = """【评审纪律】

1. 你的职责是**找出真实存在的问题**，不是确认这份 PRD 写得好。若通篇赞美，本次评审即失败。
2. 每条问题必须**引用 PRD 中的具体内容**（章节号或原文片段），泛泛而谈不计入。
3. **没有把握就明说「未发现」**，不要为凑数编造问题。编造的问题比漏掉问题更糟。
4. **不要重写 PRD、不要提出 PRD 范围外的产品设想**，只指出问题与改法。
5. 判断依据只能是这份 PRD 本身。它引用的外部项目（KVVI-Builder、DeepSeek Harness）
   你无法查阅，若某处判断依赖外部资料，请标注「依赖外部资料，无法核实」。

【输出格式】

先给一句总体判断（不超过 50 字），然后按下列结构列出问题：

## 阻断（必须修，否则不能开工）
### 1. <一句话概括问题>
- **位置**：§<章节号>
- **原文**：<引用或转述>
- **问题**：<为什么这是问题>
- **建议**：<怎么改>

## 重要（应修，影响成功率或成本）
（同结构）

## 建议（可选优化）
（同结构）

## 未发现问题的方面
<列出你检查过但认为没问题的方面，用于说明评审覆盖范围>
"""


def build_prompt(prd_text: str, lens: str) -> str:
    return f"""你是 KVVI Agent 项目的**独立评审人**。你与项目团队没有沟通渠道，
只依据下面这份 PRD 全文作出判断。请独立完成，不要假设他人已审过。

【本次评审视角】
{lens}

{DISCIPLINE}

════════════════════════════════════════════════════════
以下是 PRD 全文（KVVI Agent 产品需求文档 v2.9）
════════════════════════════════════════════════════════

{prd_text}
"""


def call_ollama(model: str, prompt: str, timeout: int = 3600):
    """调用 Ollama，返回 (正文, 思考过程, 原始响应)。

    两个实测踩过的坑（都导致「返回空串」）：
      1. `num_ctx` 太小 —— v2.5 的 PRD 有 71,979 字符，65536 不够；
      2. **`num_predict` 太小** —— `qwen3.8:27b` 是**推理模型**，思考过程写入
         `message.thinking` 而非 `message.content`。给 8192 时思考全部吃光配额，
         正文一个字都没轮到，于是 content 为空串且**不报错**。
         这里放大到 32768，并把 thinking 单独留存以便核对。
    """
    payload = {
        'model': model,
        'messages': [{'role': 'user', 'content': prompt}],
        'stream': False,
        'options': {'num_ctx': 131072, 'num_predict': 32768, 'temperature': 0.3},
    }
    request = urllib.request.Request(
        OLLAMA,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = json.loads(response.read().decode('utf-8'))
    message = body.get('message', {})
    return (message.get('content') or ''), (message.get('thinking') or ''), body


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    model, lens_id, out_name = sys.argv[1], sys.argv[2], sys.argv[3]

    lenses = json.loads((Path(__file__).resolve().parent / 'lenses.json').read_text(encoding='utf-8'))
    if lens_id not in lenses:
        print(f'未知视角 {lens_id}；可选：{", ".join(lenses)}')
        return 2
    lens = lenses[lens_id]

    prd_text = PRD.read_text(encoding='utf-8')
    prompt = build_prompt(prd_text, lens)

    out_dir = Path(__file__).resolve().parent
    prompt_digest = hashlib.sha256(prompt.encode('utf-8')).hexdigest()

    print(f'[{model}] 视角={lens_id}')
    print(f'[{model}] PRD {len(prd_text)} 字符 / prompt {len(prompt)} 字符 / sha256 {prompt_digest[:16]}…')
    started = time.time()
    try:
        answer, thinking, raw = call_ollama(model, prompt)
    except urllib.error.URLError as error:
        print(f'[{model}] 调用失败：{error}')
        return 1
    elapsed = time.time() - started

    if not answer:
        print(f'[{model}] ⚠ 正文为空（思考 {len(thinking)} 字符）。'
              f'done_reason={raw.get("done_reason")} eval_count={raw.get("eval_count")} '
              f'—— 通常是 num_predict 被思考过程吃光。', flush=True)

    (out_dir / '证据' / f'{out_name}.md').write_text(answer, encoding='utf-8')
    (out_dir / '证据' / f'{out_name}.思考过程.md').write_text(thinking, encoding='utf-8')
    record = {
        'model': model,
        'runner': 'ollama',
        'lens': lens_id,
        'prd_sha256': hashlib.sha256(prd_text.encode('utf-8')).hexdigest(),
        'prompt_sha256': prompt_digest,
        'answer_sha256': hashlib.sha256(answer.encode('utf-8')).hexdigest(),
        'answer_chars': len(answer),
        'thinking_chars': len(thinking),
        'done_reason': raw.get('done_reason'),
        'eval_count': raw.get('eval_count'),
        'elapsed_seconds': round(elapsed, 1),
    }
    (out_dir / '证据' / f'{out_name}.record.json').write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print(f'[{model}] 完成：正文 {len(answer)} 字符 / 思考 {len(thinking)} 字符，耗时 {elapsed:.0f} 秒')
    return 0 if answer else 1


if __name__ == '__main__':
    raise SystemExit(main())
