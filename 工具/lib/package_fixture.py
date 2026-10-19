"""Disposable synthetic full-build inputs used only by package self-test.

No actual DSH installation, service, model, or existing release is used here.
The caller must own the newly created temporary fixture root.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from .package_clean_build import run_clean_build


def create_fixture_sources(root, module):
    root=Path(root);module.RUNTIME_SOURCE=str(root/'vendor/dsh')
    for source,_ in module.CONTENTS:(root/source).mkdir(parents=True,exist_ok=True)
    for relative in module.REQUIRED+module.EXTRA_FILES+['vendor/dsh/packages/fixture/build/lib/types/probe.js']:
        target=root/relative;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text('{}\n' if target.suffix=='.json' else 'fixture source\n')
    source=Path(module.RUNTIME_SOURCE)
    workspaces=['vendor/*','packages/*/*','native/system','native/system/packages/*','apps/*','benchmarks','website','python/sdk-runtime']
    (source/'package.json').write_text(json.dumps(dict(version='1.0.0',workspaces=workspaces,packageManager='pnpm@11.7.0',engines={'node':'^22.19.0 || >=24.0.0'})))
    (source/'pnpm-workspace.yaml').write_text('packages:\n'+''.join('  - '+path+'\n' for path in workspaces))
    vite=source/'apps/web/vite.config.ts';vite.parent.mkdir(parents=True,exist_ok=True);vite.write_text('// owned fixture')
    host=source/'packages/fixture/host';host.mkdir(parents=True,exist_ok=True)
    (host/'package.json').write_text('{"name":"owned-host","main":"lib/index.js"}')
    (host/'tsconfig.json').write_text('{"compilerOptions":{"outDir":"lib/types"}}')


def build_owned_fixture(root, module):
    root=Path(root);objects=root/'source-objects'
    shutil.copytree(module.RUNTIME_SOURCE,objects,symlinks=True,ignore=shutil.ignore_patterns('.dsh-build','node_modules'))
    env={'PATH':os.environ.get('PATH',os.defpath),'HOME':str(root),'GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_SYSTEM':os.devnull}
    def git(*args):
        return subprocess.run(['git','-C',str(objects),*args],env=env,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True).stdout.strip()
    git('init','--quiet');git('add','--all')
    git('-c','user.name=Package Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','commit','--quiet','-m','owned synthetic input')
    head=git('rev-parse','HEAD');manifest=root/'forks/dsh/改造点指纹.json';manifest.parent.mkdir(parents=True,exist_ok=True)
    manifest.write_text(json.dumps(dict(upstream_merge_base=head,fork_head=head,count=0,files={})))
    tools=root/'synthetic tools';tools.mkdir();node=tools/'node';pnpm=tools/'pnpm.cjs';pnpm.write_text('// synthetic pnpm')
    # This executable is deliberately synthetic. Its dependency on this repo's
    # artifact collector is fixture machinery, not a qualified real toolchain.
    repository=str(Path(__file__).resolve().parents[2])
    script='''import sys,os,json,platform
from pathlib import Path
if sys.argv[1]=='-p':
 print(json.dumps(dict(version='v24.20.0',platform=sys.platform,arch='arm64' if platform.machine() in ('arm64','aarch64') else 'x64')));raise SystemExit(0)
args=sys.argv[2:]
if args==['--version']:print('11.7.0');raise SystemExit(0)
root=Path.cwd()
if args[0]=='install':(root/'node_modules').mkdir();raise SystemExit(0)
for name,body in {'apps/web/dist/index.html':b'<html>owned synthetic build</html>','packages/fixture/host/lib/index.js':b'host entry','packages/fixture/host/lib/extra.js':b'extra host'}.items():
 path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body)
sys.path.insert(0,REPOSITORY)
from 工具.lib.package_client import artifact_snapshots
rows,digest=artifact_snapshots(root);receipt=root/'.dsh-build/client-build-environment.json';receipt.parent.mkdir()
receipt.write_text(json.dumps(dict(formatVersion=1,environment={'DSH_CLIENT_COMMIT_HASH':os.environ['DSH_CLIENT_COMMIT_HASH'][:7],'DSH_CLIENT_VERSION':json.loads((root/'package.json').read_text())['version']},artifacts=dict(fileCount=len(rows),sha256=digest))))
'''.replace('REPOSITORY',repr(repository))
    node.write_text('#!'+sys.executable+'\n'+script);node.chmod(0o755);store=root/'store';store.mkdir()
    workspace=root/'built';result=run_clean_build(module.RUNTIME_SOURCE,objects,manifest,workspace,node,pnpm,store)
    if result.get('valid') is not True:raise RuntimeError('OWNED_PACKAGE_FIXTURE_BUILD_FAILED')
    receipt=workspace/'metadata/build-receipt.json';record=json.loads(receipt.read_text());output=record['outputQualification'];client=output['clientQualification']
    anchor=dict(formatVersion='kvvi-local-build-anchor/v1',validationScope='OBSERVED_LOCAL_BUILD',releaseApproved=False,runnerCommit='1'*40,
                workspace=str(workspace),runtimeSource=record['runtimeSource'],receiptPath=str(receipt),receiptSha256='sha256:'+hashlib.sha256(receipt.read_bytes()).hexdigest(),receiptBytes=receipt.stat().st_size,
                sourceEntryCount=record['inputMaterialCount'],sourceInventoryDigest=record['inputQualification']['inventoryDigest'],overlayManifestSha256=record['inputQualification']['overlayManifestSha256'],
                inputMaterialDigest=record['inputMaterialDigest'],outputCount=output['outputCount'],outputDigest=output['outputDigest'],outputBoundaryCount=len(output['outputBoundaries']),
                clientCount=client['artifactCount'],clientDigest=client['artifactDigest'],clientEnvironment=client['environment'],nodeHost=record['nodeHost'],tools=record['tools'],nativeOutput=None,
                commands=[dict(name=c['name'],exitCode=c['result']['exitCode'],cleanupConfirmed=c['result']['cleanupConfirmed'],log=c['log']) for c in record['commands']],
                readOnlyReverificationSha256='sha256:'+'2'*64,limitations=record['limitations']+['signed-attestation','unobserved-daemon-escape','packager-consumption'])
    target=root/'docs/handoff/2026-10-19/local-build-anchor.json';target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(anchor))
    module.RUNTIME_SOURCE=record['runtimeSource'];module.GIT_OBJECTS=str(objects)
