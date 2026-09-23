#!/usr/bin/env python3
"""KVVI Agent PRD 第二轮评审 — Codex（GPT）运行器。

与本地模型运行器的三点差异：
  1. 走 Codex CLI，模型为 OpenAI 家族，**与 PRD 作者（DeepSeek 家族）跨家族**；
  2. 强制 `--sandbox read-only`：评审不得改动工作区任何内容；
  3. `--ephemeral`：不持久化会话，保证每轮评审独立、不受历史污染。

用法：
    python3 run_codex_review.py <视角标识> <输出文件名>
"""
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PRD = ROOT / 'KVVI-Agent 开发文档 PRD.md'
CODEX = Path.home() / '.local' / 'bin' / 'codex'

DISCIPLINE = """【评审纪律】

1. 你的职责是**找出真实存在的问题**，不是确认这份 PRD 写得好。若通篇赞美，本次评审即失败。
2. 每条结论必须**引用 PRD 中的具体内容**（章节号或原文片段）。泛泛而谈不计入。
3. **没有把握就明说「未发现」**。编造的问题比漏掉问题更糟——上一轮评审中，有模型
   声称「§5.5 未包含 money 类型」，而 `money` 就在该节字段列表里。此类错误会直接导致误改。
4. **只依据下面提供的 PRD 文本作答，不要读取或探索工作区中的任何其他文件。**
   不要执行命令、不要修改文件。这是一次纯文本评审。
5. 不要重写 PRD、不要提出范围外的产品设想，只指出问题与改法。
6. 判断依据只能是这份 PRD 本身。它引用的外部项目（KVVI-Builder、DeepSeek Harness）
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
    return f"""你是 KVVI Agent 项目的**独立评审人**，来自与文档作者不同的模型家族。
你与项目团队没有沟通渠道，只依据下面这份 PRD 全文作出判断。

【本次评审视角】
{lens}

{DISCIPLINE}

════════════════════════════════════════════════════════
以下是 PRD 全文（KVVI Agent 产品需求文档 v2.15（第二轮终审后补齐版））
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

    prd_text = PRD.read_text(encoding='utf-8')
    prompt = build_prompt(prd_text, lens)
    prompt_digest = hashlib.sha256(prompt.encode('utf-8')).hexdigest()

    out_file = HERE / '证据' / f'{out_name}.md'

    print(f'[codex / gpt-5.6-sol] 视角={lens_id}')
    print(f'[codex] PRD {len(prd_text)} 字符 / prompt {len(prompt)} 字符')
    print(f'[codex] prompt sha256 {prompt_digest[:16]}…')
    print(f'[codex] 沙箱=read-only  会话=ephemeral  输出={out_file.name}')

    command = [
        str(CODEX), 'exec',
        '-m', 'gpt-6-astra',
        '--sandbox', 'read-only',
        '--ephemeral',
        '--skip-git-repo-check',
        '--cd', str(ROOT),
        '--output-last-message', str(out_file),
        '-',
    ]
    started = time.time()
    result = subprocess.run(command, input=prompt, text=True, capture_output=True)
    elapsed = time.time() - started

    if result.returncode != 0:
        print(f'[codex] 退出码 {result.returncode}')
        print(result.stderr[-2000:])
        return 1

    answer = out_file.read_text(encoding='utf-8') if out_file.exists() else ''
    record = {
        'runner': 'codex-cli',
        'model': 'gpt-6-astra',
        'family': 'openai',
        'lens': lens_id,
        'sandbox': 'read-only',
        'ephemeral': True,
        'prd_sha256': hashlib.sha256(prd_text.encode('utf-8')).hexdigest(),
        'prompt_sha256': prompt_digest,
        'answer_sha256': hashlib.sha256(answer.encode('utf-8')).hexdigest(),
        'answer_chars': len(answer),
        'elapsed_seconds': round(elapsed, 1),
    }
    (HERE / '证据' / f'{out_name}.record.json').write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print(f'[codex] 完成：{len(answer)} 字符，耗时 {elapsed:.0f} 秒')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
