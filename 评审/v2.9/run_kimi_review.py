#!/usr/bin/env python3
"""KVVI Agent PRD 第四轮评审 — Kimi（Moonshot）运行器。

为什么单独一个运行器：本机这把 Kimi 凭据属于 **Moonshot 开放平台**
（`api.moonshot.cn`，OpenAI 兼容格式），而不是 DSH 里配置的
Kimi For Coding 端点（`api.kimi.com/coding`，Anthropic 格式）——
后者用同一把 key 会返回 401。实测确认后按前者实现。

为什么用流式（stream）：第一版用非流式，17 分钟看不到任何进度、
无法判断是死是活。改流式后每个增量都能立刻落到日志和文件里，
既能看进度，超时也能保住已生成的部分。

密钥从 ~/.dsh/.credentials.yaml 读取，不打印、不落盘。

用法：
    python3 run_kimi_review.py <视角标识> <输出文件名>
"""
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PRD = ROOT / 'KVVI-Agent 开发文档 PRD.md'
ENDPOINT = 'https://api.moonshot.cn/v1/chat/completions'
MODEL = 'kimi-k3'

DISCIPLINE = """【评审纪律】

1. 你的职责是**找出真实存在的问题**，不是确认这份 PRD 写得好。若通篇赞美，本次评审即失败。
2. 每条结论必须**引用 PRD 中的具体内容**（章节号或原文片段）。泛泛而谈不计入。
3. **没有把握就明说「未发现」**。编造的问题比漏掉问题更糟——前几轮评审中曾有模型
   声称「§5.5 未包含 money 类型」（实际在列表中）、「§3.3 未处理未提交单据」
   （实际有整行处理）。此类错误会直接导致误改。
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
<列出你检查过但认为没问题的方面，以及依赖外部资料无法核实的部分>
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


def stream_completion(prompt: str, key: str, progress_path: Path):
    """发流式请求，边收边写。返回 (正文, 思考过程, usage)。"""
    payload = {
        'model': MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        # kimi-k3 只接受 temperature=1（实测：传 0.3 返回 400
        # "invalid temperature: only 1 is allowed for this model"）。
        'temperature': 1,
        'stream': True,
        'stream_options': {'include_usage': True},
    }
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': f'Bearer {key}',
        },
    )

    content_parts, reasoning_parts, usage = [], [], {}
    started = time.time()
    last_beat = started
    chunks = 0

    with urllib.request.urlopen(request, timeout=300) as response:
        for raw in response:
            line = raw.decode('utf-8', errors='replace').strip()
            if not line or not line.startswith('data:'):
                continue
            data = line[5:].strip()
            if data == '[DONE]':
                break
            try:
                event = json.loads(data)
            except json.JSONDecodeError:
                continue

            chunks += 1
            if event.get('usage'):
                usage = event['usage']

            for choice in event.get('choices') or []:
                delta = choice.get('delta') or {}
                if delta.get('reasoning_content'):
                    reasoning_parts.append(delta['reasoning_content'])
                if delta.get('content'):
                    content_parts.append(delta['content'])

            # 正文每增长一截就落盘，进程被杀也不丢已完成的部分。
            now = time.time()
            if now - last_beat >= 15:
                last_beat = now
                progress_path.write_text(''.join(content_parts), encoding='utf-8')
                print(
                    f'[{MODEL}] … {now - started:5.0f}s  块={chunks:5d}  '
                    f'思考={sum(len(p) for p in reasoning_parts):6d}字  '
                    f'正文={sum(len(p) for p in content_parts):6d}字',
                    flush=True,
                )

    return ''.join(content_parts), ''.join(reasoning_parts), usage, started, chunks


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
        (Path.home() / '.dsh' / '.credentials.yaml').read_text(encoding='utf-8'))['KIMI_CODING_API_KEY']

    prd_text = PRD.read_text(encoding='utf-8')
    prompt = build_prompt(prd_text, lens)
    prompt_digest = hashlib.sha256(prompt.encode('utf-8')).hexdigest()

    print(f'[{MODEL}] 视角={lens_id}', flush=True)
    print(f'[{MODEL}] PRD {len(prd_text)} 字符 / prompt {len(prompt)} 字符', flush=True)
    print(f'[{MODEL}] prompt sha256 {prompt_digest[:16]}…', flush=True)

    answer_path = HERE / '证据' / f'{out_name}.md'
    answer_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        answer, reasoning, usage, started, chunks = stream_completion(prompt, key, answer_path)
    except urllib.error.HTTPError as error:
        print(f'[{MODEL}] HTTP {error.code}: {error.read().decode()[:300]}', flush=True)
        return 1
    except Exception as error:  # noqa: BLE001 - 外部 API 的失败形态多样，统一记录后退出
        print(f'[{MODEL}] 调用失败：{type(error).__name__}: {str(error)[:200]}', flush=True)
        return 1
    elapsed = time.time() - started

    answer_path.write_text(answer, encoding='utf-8')
    (HERE / '证据' / f'{out_name}.思考过程.md').write_text(reasoning, encoding='utf-8')
    record = {
        'runner': 'moonshot-api-stream',
        'model': MODEL,
        'family': 'moonshot',
        'lens': lens_id,
        'endpoint': ENDPOINT,
        'temperature': 1,
        'prd_sha256': hashlib.sha256(prd_text.encode('utf-8')).hexdigest(),
        'prompt_sha256': prompt_digest,
        'answer_sha256': hashlib.sha256(answer.encode('utf-8')).hexdigest(),
        'answer_chars': len(answer),
        'reasoning_chars': len(reasoning),
        'stream_chunks': chunks,
        'elapsed_seconds': round(elapsed, 1),
        'usage': usage,
    }
    (HERE / '证据' / f'{out_name}.record.json').write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print(
        f'[{MODEL}] 完成：正文 {len(answer)} 字符 / 思考 {len(reasoning)} 字符，'
        f'耗时 {elapsed:.0f} 秒，tokens={usage.get("total_tokens", "?")}',
        flush=True,
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
