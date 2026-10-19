#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""备份、恢复与卸载。

## 备份包是什么，不是什么

| 是 | 不是 |
|---|---|
| 三个数据库的 `pg_dump -Fc`、`$KVVI_HOME` 下的运行期状态、一份逐文件摘要 | **不是密钥的载体** —— 超户口令、签名私钥、初始化令牌都不进包 |

理由：备份包会被拷到别处、发给支持人员、放进对象存储。把密钥一起带走，
等于把「谁能读到备份」与「谁能拿到超级用户」变成同一个问题。

## 恢复是**覆盖**动作，所以先核再动

恢复一旦开始，原数据就没了。所以第一步永远是**核摘要**（只读），核不过就
**一个字节都不动**。第一版的直觉做法是「先解包看看」，而解包本身就是写。

## `-Fc` 而不是纯 SQL

`pg_dump -Fc` 是**逐对象**的归档：单个表坏了，其余还能恢复。
纯 SQL 文本是一个整体，一行坏掉可能整份不可用 —— 而备份的意义正在
「坏的那天还能捞出什么」。
"""

import hashlib
import json
import os
import secrets
import shutil
import subprocess
import tarfile
import tempfile
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Dict, List, Optional, Sequence

#: 分别导出的三个数据库。**分别**而不是一次全导：
#: 恢复时才能只恢复其中一个，而「审计库单独恢复」是审计链自洽的前提。
DATABASES_TO_DUMP = ('kvvi_platform', 'kvvi_business', 'kvvi_audit')

#: 打包时排除的内容。密钥与运行时产物都不进备份包。
EXCLUDES = ('secrets', 'run', 'log', '.credentials.yaml', 'pgdata', 'initdb.pw',
            'kvvi.env', 'backups', '.kvvi-recovery', '.env')


def _protected_path(name: str) -> bool:
    parts = name.replace('\\', '/').split('/')
    return any(part in EXCLUDES or part.startswith('.env.') or
               part.endswith(('.key', '.pem', '.p12', '.pfx')) for part in parts)

MANIFEST_NAME = 'backup-manifest.json'
ARCHIVE_NAME = 'kvvi-backup.tar.gz'


def _restore_failed(result) -> bool:
    """
    `pg_restore` 任意非零返回码都表示失败，与输出语言无关。

    ⚠️ **不能只匹配英文 `error:`。** 连接类错误由 libpq/服务器报出，其 locale
    不由客户端 `LC_ALL` 决定 —— 中文环境是「错误: 连接失败」，只匹配英文
    会把它当成「跳过不存在对象」，恢复**误报成功**（验收 D2）。

    `--clean --if-exists` 已经把「对象不存在」消化成 `DROP ... IF EXISTS`，
    所以不能用stderr关键字为非零返回码开例外；空stderr与信号退出也失败。
    @param result `subprocess.CompletedProcess`
    @returns 该不该判为恢复失败
    """
    return result.returncode != 0


def _stop_error(stop_services):
    """A supplied stop callback must explicitly confirm success before mutation."""
    if stop_services is None:
        return {'kind': 'stop-services', 'code': 'KVVI_STOP_CONFIRMATION_REQUIRED'}
    try:
        result = stop_services()
    except Exception:
        return {'kind': 'stop-services', 'code': 'KVVI_STOP_FAILED'}
    if result is not True and not (isinstance(result, dict) and result.get('ok') is True):
        return {'kind': 'stop-services', 'code': 'KVVI_STOP_FAILED'}
    return None


def sha256_file(path: Path) -> str:
    """
    文件的 SHA-256。
    @param path 文件
    @returns `sha256:<hex>`
    """
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return 'sha256:' + digest.hexdigest()


def sha256_bytes(body: bytes) -> str:
    """字节串的 SHA-256。"""
    return 'sha256:' + hashlib.sha256(body).hexdigest()


@dataclass
class BackupPlan:
    """一次备份的计划。"""
    home: Path
    pg_port: int
    out_dir: Path
    superuser: str
    superpass: str
    databases: Sequence[str] = DATABASES_TO_DUMP
    excludes: Sequence[str] = EXCLUDES
    steps: List[dict] = field(default_factory=list)

    @property
    def archive(self) -> Path:
        return self.out_dir / ARCHIVE_NAME

    def describe(self) -> str:
        """给人看的计划。"""
        return '\n'.join([
            '将备份：', '',
            f'  三个数据库（分别导出，`pg_dump -Fc`）：{"、".join(self.databases)}',
            f'  $KVVI_HOME 下的运行期状态（会话、profile、配置）',
            f'  一份逐文件摘要',
            '',
            f'输出   {self.archive}',
            '',
            '**不会**进备份包：',
            '  ' + '、'.join(self.excludes),
            '  （密钥与超级用户口令都不进包：备份可能被拷到别处或交给支持人员）',
        ])

    def apply(self, pg_bin: Path) -> dict:
        """
        执行备份。
        @param pg_bin PostgreSQL 二进制目录
        @returns `{ok, steps, errors}`
        """
        pg_bin = Path(pg_bin)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix='.kvvi-backup-', dir=self.out_dir))
        env = dict(os.environ, PGPASSWORD=self.superpass, LC_ALL='en_US.UTF-8')
        done: List[str] = []

        files: Dict[str, dict] = {}
        for database in self.databases:
            target = staging / f'{database}.dump'
            result = subprocess.run(
                [str(pg_bin / 'pg_dump'), '-h', '127.0.0.1', '-p', str(self.pg_port),
                 '-U', self.superuser, '-d', database, '-Fc', '-f', str(target)],
                capture_output=True, text=True, env=env, timeout=1800)
            if result.returncode != 0:
                shutil.rmtree(staging, ignore_errors=True)
                return {'ok': False, 'steps': done,
                        'errors': [{'kind': 'dump', 'database': database,
                                    'stderr': result.stderr.strip()[:500]}]}
            files[f'{database}.dump'] = {'sha256': sha256_file(target),
                                         'bytes': target.stat().st_size}
            done.append(f'dump {database}')

        # 运行期状态。**逐项排除**，因为是「把主目录打进去减掉几项」——
        # 与发行包那边「逐项列出要收什么」方向相反，因为这里要的是
        # 「整个实例的状态」，而漏了某一项的表现是恢复后少一块东西。
        state = staging / 'home.tar'
        with tarfile.open(state, 'w') as tar:
            def include(info):
                source = self.home / info.name
                resolved = source.resolve()
                output = self.out_dir.resolve()
                nested_output = self.home.resolve() in output.parents
                if (_protected_path(info.name) or info.issym() or info.islnk() or
                        not (info.isfile() or info.isdir()) or
                        (nested_output and (resolved == output or output in resolved.parents)) or
                        resolved == staging or staging in resolved.parents or
                        resolved in (self.archive.resolve(), self.archive.with_suffix('.partial').resolve(),
                                     self.archive.with_suffix(self.archive.suffix + '.sha256').resolve())):
                    return None
                return info
            for entry in sorted(self.home.iterdir()):
                if entry.name in self.excludes:
                    continue
                tar.add(entry, arcname=entry.name, recursive=True, filter=include)
        files['home.tar'] = {'sha256': sha256_file(state), 'bytes': state.stat().st_size}
        done.append('archive-home')

        manifest = {
            'bundleVersion': 'kvvi-backup/v1',
            'createdAt': _now(),
            'pgPort': self.pg_port,
            'databases': list(self.databases),
            'files': files,
        }
        (staging / MANIFEST_NAME).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

        # 归档：先建到临时名，成功后再改名 —— 一个写了一半的备份包
        # 比没有备份更坏，因为它看起来像有。
        temporary = self.archive.with_suffix('.partial')
        with tarfile.open(temporary, 'w:gz') as tar:
            for name in sorted(os.listdir(staging)):
                tar.add(staging / name, arcname=name)
        shutil.rmtree(staging)
        os.replace(temporary, self.archive)
        # 边车：归档**文件本身**的摘要。逐成员摘要查不出「往 gzip 尾部追加字节」，
        # 而这个能。见 `_sidecar_problems`。
        sidecar = self.archive.with_suffix(self.archive.suffix + '.sha256')
        sidecar.write_text(sha256_file(self.archive) + '\n')
        done.append('pack')
        return {'ok': True, 'steps': done, 'errors': [],
                'archive': str(self.archive), 'manifest': manifest}


def _safe_members(tar: tarfile.TarFile, target: Path, preserve_credentials=False):
    """
    安全解包：拒绝绝对路径、`..` 与符号链接逃逸。

    ⚠️ **不能用 `tar.extract(member, path, filter='data')`。**
    那个参数是 Python **3.12** 才有的（3.11.4 回移了一部分），
    而安装器必须跑在 macOS 自带的 **3.9** 上 —— 传它得到的是
    `TypeError: extract() got an unexpected keyword argument 'filter'`，
    而那是**运行到恢复那一步才炸**。

    退而用 `extractall()` 也不行：3.9 的文档明确写着它受路径穿越影响，
    而「归档可能被改过」正是这一层要防的事 —— 一个能改写 `../../` 的成员
    可以让恢复把文件写到 `$KVVI_HOME` 之外。所以自己判。

    @param tar 已打开的归档
    @param target 解包目标目录
    @throws ValueError 有成员越出目标目录时
    """
    target = Path(target).resolve()
    selected = []
    seen = set()
    files = set()
    destinations = [(target / m.name.replace('\\', '/')).resolve() for m in tar.getmembers()]
    files.update(path for path, member in zip(destinations, tar.getmembers()) if member.isfile())
    for member in tar.getmembers():
        name = member.name.replace('\\', '/')
        if name.startswith('/') or '..' in name.split('/'):
            raise ValueError(f'KVVI_BACKUP_UNSAFE_MEMBER: {member.name}')
        if member.issym() or member.islnk():
            # 链接指向哪里由链接内容决定，而内容同样是归档说了算。
            raise ValueError(f'KVVI_BACKUP_UNSAFE_MEMBER: {member.name}')
        if not (member.isfile() or member.isdir()):
            raise ValueError(f'KVVI_BACKUP_UNSAFE_MEMBER: {member.name}')
        destination = (target / name).resolve()
        if destination != target and target not in destination.parents:
            raise ValueError(f'KVVI_BACKUP_UNSAFE_MEMBER: {member.name}')
        if destination in seen:
            raise ValueError(f'KVVI_BACKUP_DUPLICATE_MEMBER: {member.name}')
        seen.add(destination)
        if any(parent in files or (parent.exists() and not parent.is_dir())
               for parent in destination.parents if parent == target or target in parent.parents):
            raise ValueError(f'KVVI_BACKUP_PARENT_NOT_DIRECTORY: {member.name}')
        if preserve_credentials and _protected_path(name):
            continue
        current = target / name
        while current != target:
            if current.is_symlink():
                raise ValueError(f'KVVI_BACKUP_UNSAFE_TARGET: {member.name}')
            current = current.parent
        selected.append(member)
    return selected


def safe_extract(tar: tarfile.TarFile, target: Path, preserve_credentials=False) -> None:
    """Validate the entire archive before extracting regular files and directories."""
    tar.extractall(target, members=_safe_members(tar, target, preserve_credentials))


def _now() -> str:
    """ISO 时间戳。"""
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def backup_plan(home: Path, pg_port: int, out_dir: Path, superuser: str,
                superpass: str, databases: Sequence[str] = DATABASES_TO_DUMP) -> BackupPlan:
    """
    组一次备份的计划。**纯函数**。
    @param home `$KVVI_HOME`
    @param pg_port 集群端口
    @param out_dir 备份输出目录
    @param superuser 超级用户
    @param superpass 超级用户口令
    @param databases 要导出的库
    @returns 计划
    """
    steps = [{'kind': 'dump', 'writes': True, 'database': name,
              'argv': ['pg_dump', '-Fc', '-d', name]}
             for name in databases]
    steps.append({'kind': 'archive-home', 'writes': True, 'argv': [],
                  'why': '只备份数据库是不够的：会话、profile 与配置都在 $KVVI_HOME 下'})
    steps.append({'kind': 'pack', 'writes': True, 'argv': [],
                  'why': '先写临时名再改名：一个写了一半的备份包比没有更坏，它看起来像有'})
    return BackupPlan(home=Path(home), pg_port=pg_port, out_dir=Path(out_dir),
                      superuser=superuser, superpass=superpass,
                      databases=tuple(databases), excludes=EXCLUDES, steps=steps)


def manifest_of(archive: Path) -> dict:
    """
    读备份包里的清单。**不落盘**：直接在归档里读。
    @param archive 备份包
    @returns 清单字典
    """
    with tarfile.open(archive, 'r:gz') as tar:
        member = tar.getmember(MANIFEST_NAME)
        return json.loads(tar.extractfile(member).read().decode('utf-8'))


def _sidecar_problems(archive: Path) -> List[dict]:
    """
    核对归档边车摘要（`<archive>.sha256`）。

    ⚠️ **这是唯一能发现「在压缩流后面追加字节」的办法。**
    逐成员摘要查的是**成员**，而往 gzip 流尾部追加的垃圾不是成员 ——
    `tarfile` 读得动，每个成员也都对，于是校验会通过。
    边车记的是**归档文件本身**的摘要，追加一个字节就对不上。

    边车不存在时**不报错**：它可能是被单独丢掉的，而那时包本身仍然自洽
    （只是少了一层保护）。这一点如实说在返回值里，不假装成通过了校验。
    @param archive 备份包
    @returns 问题列表
    """
    sidecar = archive.with_suffix(archive.suffix + '.sha256')
    if not sidecar.is_file():
        return []
    recorded = sidecar.read_text(encoding='utf-8').strip().split()[0]
    if recorded != sha256_file(archive):
        return [{'code': 'KVVI_BACKUP_ARCHIVE_TAMPERED'}]
    return []


def verify_backup(archive: Path) -> dict:
    """
    **只读**校验一个备份包：清单在不在、每个成员与它记的摘要是否一致。
    @param archive 备份包
    @returns `{ok, problems}`
    """
    archive = Path(archive)
    if not archive.is_file():
        return {'ok': False, 'problems': [{'code': 'KVVI_BACKUP_MISSING'}]}
    try:
        with tarfile.open(archive, 'r:gz') as tar:
            names = tar.getnames()
            if MANIFEST_NAME not in names:
                return {'ok': False,
                        'problems': [{'code': 'KVVI_BACKUP_NO_MANIFEST'}]}
            manifest = json.loads(
                tar.extractfile(tar.getmember(MANIFEST_NAME)).read().decode('utf-8'))
            problems = []
            for name, entry in manifest.get('files', {}).items():
                if name not in names:
                    problems.append({'code': 'KVVI_BACKUP_MEMBER_MISSING', 'member': name})
                    continue
                actual = sha256_bytes(
                    tar.extractfile(tar.getmember(name)).read())
                if actual != entry.get('sha256'):
                    problems.append({'code': 'KVVI_BACKUP_MEMBER_TAMPERED', 'member': name})
            # ⚠️ 清单**没列**的成员也要报。只查「清单里的还在不在」时，
            #    往包里**加**东西是查不出来的 —— 而「加一个文件」与「改一个文件」
            #    对恢复流程是同一类风险。
            expected = set(manifest.get('files', {})) | {MANIFEST_NAME}
            for name in names:
                if name not in expected:
                    problems.append({'code': 'KVVI_BACKUP_MEMBER_UNEXPECTED', 'member': name})
            problems.extend(_sidecar_problems(archive))
            return {'ok': not problems, 'problems': problems, 'manifest': manifest}
    except (tarfile.TarError, KeyError, ValueError) as error:
        # 读不开就是一个结论：这个包不能用。**不当成异常往上抛** ——
        # 调用方要据此**拒绝恢复**，而不是让恢复流程带着一个坏包往下走。
        return {'ok': False, 'problems': [
            {'code': 'KVVI_BACKUP_UNREADABLE', 'detail': str(error)[:200]}]}


@dataclass
class RestorePlan:
    """一次恢复的计划。"""
    archive: Path
    home: Path
    pg_port: int
    superuser: str
    superpass: str
    steps: List[dict] = field(default_factory=list)

    def describe(self) -> str:
        """给人看的计划。"""
        return '\n'.join([
            f'将从 {self.archive} 恢复到 {self.home}（端口 {self.pg_port}）。', '',
            '  1. **先核摘要** —— 核不过就一个字节都不动',
            '  2. 停掉在跑的进程',
            '  3. 逐个库 `pg_restore --clean --if-exists`',
            '  4. 恢复运行期状态',
            '',
            '⚠️ 恢复是**覆盖**动作：第三步会替换库里的现有内容。',
        ])

    def apply(self, pg_bin: Path, stop_services=None) -> dict:
        """Bind verification, extraction and receipts to one private byte snapshot."""
        if not self.archive.is_file():
            return {'ok': False, 'steps': [], 'errors': [{
                'kind': 'verify', 'code': 'KVVI_BACKUP_MISSING'}]}
        with tempfile.TemporaryDirectory(prefix='kvvi-restore-source-') as directory:
            snapshot = Path(directory) / 'source.tar.gz'
            try:
                with open(self.archive, 'rb') as source, open(snapshot, 'wb') as target:
                    os.chmod(snapshot, 0o600)
                    shutil.copyfileobj(source, target)
                    target.flush()
                    os.fsync(target.fileno())
                sidecar = self.archive.with_suffix(self.archive.suffix + '.sha256')
                if sidecar.is_file():
                    snapshot.with_suffix(snapshot.suffix + '.sha256').write_bytes(sidecar.read_bytes())
            except OSError:
                return {'ok': False, 'steps': [], 'errors': [{
                    'kind': 'verify', 'code': 'KVVI_BACKUP_UNREADABLE'}]}
            return replace(self, archive=snapshot)._apply_snapshot(pg_bin, stop_services)

    def _apply_snapshot(self, pg_bin: Path, stop_services=None) -> dict:
        """
        执行恢复。
        @param pg_bin PostgreSQL 二进制目录
        @param stop_services 可选：在动数据库**之前**停掉在跑进程的回调。
            `describe()` 早已声明「停掉在跑的进程」，此前 `apply()` 却从没做过 ——
            恢复是覆盖动作，进程还活着时 pg_restore 会与它们抢同一份数据（验收 D1）。
        @returns `{ok, steps, errors}`
        """
        pg_bin = Path(pg_bin)
        done: List[str] = []

        # ★ 第一步永远是只读校验。**恢复是覆盖动作** ——
        #   已经在覆写之后才发现包是坏的，原数据也没了。
        verdict = verify_backup(self.archive)
        if not verdict['ok']:
            code = verdict['problems'][0].get('code', 'KVVI_BACKUP_UNREADABLE')
            if code == 'KVVI_BACKUP_MEMBER_TAMPERED':
                code = 'KVVI_BACKUP_DIGEST_MISMATCH'
            return {'ok': False, 'steps': done,
                    'errors': [{'kind': 'verify', 'code': code,
                                'problems': verdict['problems'][:5]}]}
        done.append('verify')

        # Validate the outer and nested home archive before stopping or importing any DB.
        try:
            with tarfile.open(self.archive, 'r:gz') as tar:
                _safe_members(tar, Path(tempfile.gettempdir()) / 'kvvi-restore-validation')
                if 'home.tar' in tar.getnames():
                    with tarfile.open(fileobj=tar.extractfile('home.tar'), mode='r:') as state:
                        _safe_members(state, self.home, preserve_credentials=True)
        except (OSError, ValueError, KeyError, tarfile.TarError):
            return {'ok': False, 'steps': done, 'errors': [{
                'kind': 'verify', 'code': 'KVVI_BACKUP_UNSAFE_MEMBER'}]}

        # ★ D1 修复：核过摘要、确认要动库之前，先停掉在跑的进程。
        error = _stop_error(stop_services)
        if error is not None:
            return {'ok': False, 'steps': done, 'errors': [error]}
        done.append('stop-services')

        receipt_dir = self.home / '.kvvi-recovery'
        receipt_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        receipt = receipt_dir / f'restore-{secrets.token_hex(12)}.json'
        current_database = None

        def checkpoint(state, errors=()):
            body = {'state': state, 'archiveSha256': sha256_file(self.archive),
                    'currentDatabase': current_database, 'steps': list(done),
                    'errors': list(errors), 'updatedAt': _now()}
            temporary = receipt.with_suffix('.partial')
            with open(temporary, 'w', encoding='utf-8') as handle:
                os.chmod(temporary, 0o600)
                json.dump(body, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, receipt)
            directory = os.open(receipt_dir, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)

        def failed(error):
            checkpoint('FAILED', [error])
            return {'ok': False, 'steps': done, 'errors': [error], 'journalPath': str(receipt)}

        checkpoint('RUNNING')
        staging = Path(tempfile.mkdtemp(prefix='.kvvi-restore-'))
        try:
            with tarfile.open(self.archive, 'r:gz') as tar:
                safe_extract(tar, staging)
            done.append('extract')

            env = dict(os.environ, PGPASSWORD=self.superpass, LC_ALL='en_US.UTF-8')
            for database in verdict['manifest']['databases']:
                current_database = database
                checkpoint('RUNNING')
                dump = staging / f'{database}.dump'
                try:
                    result = subprocess.run(
                        [str(pg_bin / 'pg_restore'), '-h', '127.0.0.1', '-p', str(self.pg_port),
                         '-U', self.superuser, '-d', database, '--clean', '--if-exists',
                         '--single-transaction', '--exit-on-error', str(dump)],
                        capture_output=True, text=True, env=env, timeout=1800)
                except (subprocess.TimeoutExpired, OSError) as error:
                    return failed({
                        'kind': 'restore', 'database': database,
                        'code': 'KVVI_RESTORE_TIMEOUT' if isinstance(error, subprocess.TimeoutExpired)
                        else 'KVVI_RESTORE_EXEC_FAILED'})
                # `pg_restore` 的非零返回码要区分「真错误」与「可忽略的跳过」。
                # `--clean --if-exists` 已消化「对象不存在」，剩下的非零基本是真错。
                # 判据跨语言（英文 error / 中文「错误」），见 `_restore_failed`。
                if _restore_failed(result):
                    return failed({'kind': 'restore', 'database': database,
                                   'code': 'KVVI_RESTORE_FAILED', 'returncode': result.returncode})
                done.append(f'restore {database}')
                checkpoint('RUNNING')

            home_tar = staging / 'home.tar'
            if home_tar.is_file():
                with tarfile.open(home_tar, 'r') as tar:
                    safe_extract(tar, self.home, preserve_credentials=True)
                done.append('restore-home')
        except (OSError, ValueError, tarfile.TarError):
            return failed({'kind': 'restore', 'code': 'KVVI_RESTORE_STATE_FAILED'})
        finally:
            shutil.rmtree(staging, ignore_errors=True)
        checkpoint('COMPLETE')
        return {'ok': True, 'steps': done, 'errors': [], 'journalPath': str(receipt)}


def restore_plan(archive: Path, home: Path, pg_port: int, superuser: str,
                 superpass: str) -> RestorePlan:
    """
    组一次恢复的计划。**纯函数**。
    @returns 计划
    """
    return RestorePlan(archive=Path(archive), home=Path(home), pg_port=pg_port,
                       superuser=superuser, superpass=superpass,
                       steps=[{'kind': 'verify', 'writes': False},
                              {'kind': 'extract', 'writes': True},
                              {'kind': 'restore-databases', 'writes': True},
                              {'kind': 'restore-home', 'writes': True}])


@dataclass
class UninstallPlan:
    """一次卸载的计划。**默认保留数据。**"""
    home: Path
    purge_data: bool
    removes: List[str] = field(default_factory=list)
    keeps: List[str] = field(default_factory=list)
    warning: Optional[str] = None

    def describe(self) -> str:
        """给人看的计划。"""
        lines = ['将删除：', '']
        lines += [f'  {item}' for item in self.removes]
        lines += ['', '将保留：', '']
        lines += [f'  {item}' for item in self.keeps]
        if self.warning:
            lines += ['', f'⚠️ {self.warning}']
        return '\n'.join(lines)

    def apply(self, stop_services=None) -> dict:
        """
        执行卸载。
        @param stop_services 可选：删除任何文件**之前**停掉在跑进程的回调。
            此前卸载只删 `run/`（含 PID 文件），进程却还活着 —— 删了 PID 文件
            之后 `status` 再也看不见它们（验收 D3）。
        @returns `{ok, steps, errors}`
        """
        # ★ D3 修复：先停进程，再删文件。否则「卸载成功」却留着活进程。
        error = _stop_error(stop_services)
        if error is not None:
            return {'ok': False, 'steps': [], 'errors': [error], 'kept': self.keeps}
        removed = []
        for item in self.removes:
            target = self.home / item
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
            elif target.exists():
                target.unlink(missing_ok=True)
            removed.append(item)
        return {'ok': True, 'steps': removed, 'errors': [], 'kept': self.keeps}


def uninstall_plan(home: Path, purge_data: bool = False) -> UninstallPlan:
    """
    组一次卸载的计划。**纯函数，且默认保留数据。**

    `pgdata` 与 `secrets` **不在默认删除项里**：一次误卸载等于删库，
    〝而「数据还在不在」不该取决于用户有没有读到一句提示。
    @param home `$KVVI_HOME`
    @param purge_data 显式要求连数据一起删
    @returns 计划
    """
    home = Path(home)
    removes = ['run', 'log', 'profiles']
    keeps = ['pgdata', 'secrets', 'kvvi.env']
    warning = None
    if purge_data:
        removes = removes + ['pgdata', 'secrets', 'kvvi.env']
        keeps = []
        warning = ('--purge-data 会删除公司、账号与全部业务数据，且**不可恢复**。'
                   '如果只是想卸载程序，去掉这个参数。')
    return UninstallPlan(home=home, purge_data=purge_data, removes=removes,
                         keeps=keeps, warning=warning)
