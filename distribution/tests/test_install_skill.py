#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阶段十一 · 任务四：受限的安装 Agent Skill。

## 为什么安装这件事要有 Skill，又不能自由发挥

装 KVVI 是一串**有序**且**会改机器**的动作。让 Agent 自由发挥有三个具体风险：

| # | 风险 | 这一组怎么挡 |
|---|---|---|
| 1 | 它自己拼命令（`sh -c`、`curl … \| sh`） | 只允许调用固定的三个包装脚本，脚本自己校验参数 |
| 2 | 它自作主张 `--yes` | 脚本**不接受**隐式确认；`apply.sh` 必须显式带 `--confirm` |
| 3 | 环境不合适时它硬上 | `check.sh` 不通过时**不给** apply 命令 |

## 这一组测的是「文本」而不是「运行时」

Skill 是被模型读的 Markdown 与几个 shell 脚本。所以断言落在**文本与脚本本身**上：
引用了哪些命令、有没有出现危险的形状。这类东西没有「跑一遍」的验法 ——
它出错的形式是模型照着写出了一个我们没打算给的命令。

⚠️ 第 3 条尤其重要：一个「PostgreSQL 没装」的检查结果，若 Skill 里照样给出
apply 命令，模型就会带着一个必然失败的安装往下走，而客户看到的是
一个跑了十分钟才报错的安装。**引导必须落在「下一步做什么」，不是「哪里错了」。**
"""

import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

SKILL_DIR = Path(__file__).resolve().parents[1] / 'skills' / 'kvvi-install'
SKILL = SKILL_DIR / 'SKILL.md'
SCRIPTS = ('check.sh', 'plan.sh', 'apply.sh')

#: Skill 允许引用的 `kvvi-admin` 子命令。多一个就是能力边界变了。
ALLOWED_SUBCOMMANDS = ('preflight', 'install', 'start', 'stop', 'status',
                       'backup', 'restore', 'uninstall', 'rollback')

#: 明确的禁止形状。每条都对应一种「模型自己发明了做法」。
FORBIDDEN_PATTERNS = (
    (r'\bsh\s+-c\b', 'shell 里再套一层 shell —— 参数校验会被绕过'),
    (r'\bcurl\b[^\n]*\|', '把远端内容直接管进 shell'),
    (r'\bwget\b[^\n]*\|', '同上'),
    (r'\beval\b', 'eval 会把字符串当代码跑'),
    (r'\bsudo\b', '安装不需要也不应该要 root'),
    (r'--yes\s*$', '隐式确认'),
    (r'\brm\s+-rf\s+/', '对根路径做递归删除'),
)


def skill_text() -> str:
    """Skill 全文。"""
    return SKILL.read_text(encoding='utf-8')


def runnable_text() -> str:
    """
    只取 Skill 里**模型会照抄执行**的部分：围栏代码块与行内代码。

    ⚠️ 不能扫全文。这份 Skill 明确写着「你不写 `sh -c`、不用 `eval`、
    全程 `sudo` 都不需要」—— 那是**禁止**，而朴素的全文扫描分不出
    「禁止这个形状」与「用这个形状」，于是它会把一份正确的 Skill 判成错的。

    判据是：会被复制去执行的东西在代码里，其余是给人读的话。

    这条判据反过来也约束 Skill 的写法：**被禁止的形状不能写成代码**。
    第一版把「你不写 `sh -c`、不用 `eval`、`sudo` 都不需要」写成行内代码，
    于是这份正确的 Skill 被自己判成错的 —— 而那个写法本身也确实不好：
    一个被禁止的东西写成可复制的样子，读者先看到形状、才读到前面的「不」。
    """
    text = skill_text()
    blocks = re.findall(r'```[a-z]*\n(.*?)```', text, re.DOTALL)
    spans = re.findall(r'`([^`\n]+)`', text)
    return '\n'.join(blocks + spans)


def script_text(name: str) -> str:
    """一个包装脚本的全文。"""
    return (SKILL_DIR / 'scripts' / name).read_text(encoding='utf-8')


class SkillPresenceTest(unittest.TestCase):
    """四个文件必须都在，且脚本可执行。"""

    def test_skill_and_scripts_exist(self):
        self.assertTrue(SKILL.is_file(), f'缺 {SKILL}')
        for name in SCRIPTS:
            with self.subTest(script=name):
                path = SKILL_DIR / 'scripts' / name
                self.assertTrue(path.is_file(), f'缺 {path}')

    def test_scripts_are_executable(self):
        for name in SCRIPTS:
            with self.subTest(script=name):
                path = SKILL_DIR / 'scripts' / name
                self.assertTrue(path.stat().st_mode & 0o111, f'{name} 不可执行')

    def test_scripts_run_under_macos_bash(self):
        """
        用 **/bin/bash**（macOS 自带的 3.2）跑一遍，不带任何配置。

        ⚠️ 这一条是被两个真实缺陷逼出来的：
          1. `set -u` 下展开**空数组**在 3.2 上直接报 `unbound variable` ——
             于是「不带配置」三个脚本全跑不起来，而「带配置」一切正常。
             这种「有参数能用、没参数不能」最难查。
          2. 修的时候第一版用了 `$(config_args)`（命令替换 + 词拆分），
             而默认主目录是 `~/Library/Application Support/KVVI-Agent` ——
             **路径里有空格**，词拆分会把一个路径拆成两个参数。
        两个坑都只在**不带配置**时暴露，所以这条必须在无配置下跑。
        """
        for name in SCRIPTS:
            with self.subTest(script=name):
                result = subprocess.run(
                    ['/bin/bash', str(SKILL_DIR / 'scripts' / name), '--unlikely-arg'],
                    capture_output=True, text=True,
                    env={k: v for k, v in __import__('os').environ.items()
                         if k != 'KVVI_CONFIG'})
                # 不关心它成功与否（环境可能不合适），只关心**它没有崩在 shell 语法上**。
                combined = result.stdout + result.stderr
                self.assertNotIn('unbound variable', combined,
                                 f'{name} 在 bash 3.2 上因空数组展开而崩')

    def test_scripts_parse_as_shell(self):
        for name in SCRIPTS:
            with self.subTest(script=name):
                result = subprocess.run(['bash', '-n', str(SKILL_DIR / 'scripts' / name)],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)


class AllowlistTest(unittest.TestCase):
    """只允许那几个子命令，且不许出现危险形状。"""

    def test_skill_only_references_allowed_subcommands(self):
        # 从 `kvvi-admin <sub>` 与 `admin <sub>` 两种写法里抠出子命令。
        # 只看**可执行**的那部分：散文里提到某个命令不存在，与叫模型去跑它，是两回事。
        found = set(re.findall(r'(?:kvvi-admin|\badmin)\s+([a-z][a-z-]*)', runnable_text()))
        found -= {'--plan', '--apply', '--yes', '--json', '--config', '--out',
                  '--purge-data', '--target-version', '--help'}
        unexpected = {name for name in found if name not in ALLOWED_SUBCOMMANDS}
        self.assertEqual(unexpected, set(),
                         f'Skill 引用了清单外的子命令：{sorted(unexpected)}')

    def test_skill_has_no_forbidden_shapes(self):
        # 同上：只在可执行部分里找。「不要用 eval」是好句子，不是坏形状。
        text = runnable_text()
        for pattern, why in FORBIDDEN_PATTERNS:
            with self.subTest(pattern=pattern):
                self.assertIsNone(re.search(pattern, text, re.MULTILINE),
                                  f'Skill 里出现了被禁止的形状（{why}）')

    def test_scripts_have_no_forbidden_shapes(self):
        for name in SCRIPTS:
            text = script_text(name)
            for pattern, why in FORBIDDEN_PATTERNS:
                with self.subTest(script=name, pattern=pattern):
                    # `--yes` 出现在脚本内部是**明确**的（脚本自己加），
                    # 只禁止它出现在「读进来的参数」那条路径上。
                    if pattern == r'--yes\s*$':
                        continue
                    self.assertIsNone(re.search(pattern, text, re.MULTILINE),
                                      f'{name} 里出现了被禁止的形状（{why}）')

    def test_scripts_only_call_kvvi_admin(self):
        # 脚本能执行的外部命令只该是 kvvi-admin 与最基本的 shell 工具。
        allowed = {'kvvi-admin', 'printf', 'echo', 'exit', 'cat', 'test', 'dirname',
                   'cd', 'set', 'if', 'then', 'fi', 'case', 'esac', 'read', 'local',
                   'return', 'command', 'grep', 'sed', 'python3', 'pwd'}
        for name in SCRIPTS:
            text = script_text(name)
            invoked = set(re.findall(r'^\s*([a-z][a-z0-9_-]*)\s', text, re.MULTILINE))
            # `for` 是 shell 关键字；`run_admin` 是本目录 `_common.sh` 里
            # 自己定义的包装函数 —— 它内部只调 `kvvi-admin`。
            invoked -= {'set', 'if', 'then', 'fi', 'case', 'esac', 'while', 'do', 'done',
                        'local', 'return', 'echo', 'printf', 'read', 'exit', 'test',
                        'cd', 'exec', 'source', 'for', 'run_admin'}
            unexpected = {cmd for cmd in invoked
                          if cmd not in allowed and not cmd.startswith('KVVI_')}
            self.assertEqual(unexpected, set(),
                             f'{name} 调用了清单外的命令：{sorted(unexpected)}')


class GuidanceTest(unittest.TestCase):
    """环境不合适时，Skill 的引导必须落在「下一步做什么」。"""

    def test_missing_postgres_guidance_names_the_formula(self):
        text = skill_text()
        self.assertIn('brew install postgresql@17', text)

    def test_skill_says_no_apply_when_the_check_fails(self):
        # 这句话必须**明确写出来**：一个只在心里知道「不通过就别装」的 Skill，
        # 模型是读不到的。
        #
        # ⚠️ 用「不通过」那一段作为窗口，不在整篇里找 —— 整篇找的话，
        #    任何一处出现过「不要」加「apply」就算过，而那证明不了
        #    这句话是挂在**失败分支**上的。
        text = skill_text()
        start = text.find('环境检查不通过')
        self.assertNotEqual(start, -1, 'Skill 里没有「环境检查不通过」的分支')
        window = text[start:start + 200]
        self.assertRegex(window, r'不要[^\n]*apply',
                         '「不通过」那一段没有写明「不要执行 apply」')

    def test_skill_forbids_implicit_confirmation(self):
        text = skill_text()
        self.assertRegex(text, r'--confirm', 'Skill 没有说明 apply 需要显式确认')

    def test_apply_script_refuses_without_confirmation(self):
        # 判据写在**脚本**里，不只在 Skill 的文字里：
        # 文字是给模型看的，脚本是被执行的，两者都要有。
        text = script_text('apply.sh')
        self.assertIn('--confirm', text)
        result = subprocess.run(['bash', str(SKILL_DIR / 'scripts' / 'apply.sh')],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0, '不带 --confirm 也能执行 apply')
        self.assertIn('confirm', (result.stdout + result.stderr).lower())

    def test_skill_states_what_it_will_not_do(self):
        # 「不做什么」与「做什么」同样重要 —— 而且它必须能读到。
        text = skill_text()
        self.assertRegex(text, r'(不做什么|不会做|不承诺|禁止)', 'Skill 没有「不做什么」一节')


if __name__ == '__main__':
    unittest.main()
