from pathlib import Path
from html import escape
from PIL import ImageFont
import json

OUT = Path(__file__).parent
W,H=1980,1830
FONT='Noto Sans CJK SC, sans-serif'
parts=[]
def rect(x,y,w,h,fill,stroke='none',r=16,dash=False):
    parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="2" '+('stroke-dasharray="9 6" ' if dash else '')+'/>')
def txt(x,y,s,size=24,color='#26394e',weight=400,anchor='start'):
    parts.append(f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" fill="{color}" text-anchor="{anchor}">{escape(s)}</text>')
def arrow(points,color='#8297aa',dash=False):
    d='M '+' L '.join(f'{x},{y}' for x,y in points)
    parts.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="3" stroke-linejoin="round" marker-end="url(#arrow)" '+('stroke-dasharray="8 7" ' if dash else '')+'/>')
colors=['#287fbd','#238866','#7754b6']
bg=['#f0f6fc','#edf8f3','#f5f1fa']
panels=[55,690,1325]
cards={}
def card(key,p,y,title,lines,owner,proposed=False,h=92):
    x=panels[p]+98;w=414;c=colors[p]
    cards[key]=(x,y,w,h)
    rect(x,y,w,h,'#ffffff',c,dash=proposed)
    txt(x+19,y+32,title,23,c,700)
    for i,line in enumerate(lines):txt(x+19,y+59+i*22,line,18,'#596d80')
    txt(x+w-14,y+29,owner,14,'#8695a4',400,'end')
def down(a,b,label=''):
    x,y,w,h=cards[a];xx,yy,ww,hh=cards[b]
    arrow([(x+w/2,y+h),(xx+ww/2,yy)])
    if label:txt(x+w/2+12,(y+h+yy)/2+6,label,16,'#657a8d')
def loop(a,b,p,label,side='right'):
    x,y,w,h=cards[a];xx,yy,ww,hh=cards[b];c=colors[p]
    rail=panels[p]+555 if side=='right' else panels[p]+54
    sx=x+w if side=='right' else x
    tx=xx+ww if side=='right' else xx
    arrow([(sx,y+h/2),(rail,y+h/2),(rail,yy+hh/2),(tx,yy+hh/2)],c,True)
    lx=rail+8 if side=='right' else rail-8
    for i,l in enumerate(label):txt(lx,(y+yy)/2+31*i,l,16,c,400,'start' if side=='right' else 'end')

parts.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
parts.append('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10Z" fill="context-stroke"/></marker></defs>')
rect(0,0,W,H,'#ffffff',r=0)
rect(55,38,1870,141,'#f5f8fb',r=24)
txt(87,101,'KVVI-Agent',48,'#17687b',700)
txt(426,101,'AI Agent 三闭环流程',48,'#20344b',700)
txt(88,147,'搭建、发布、使用各自闭环；通过发布内容和业务结果连接，不要求一个会话从头运行到底。',24,'#62758a')
rect(55,202,1870,97,'#eaf2f6',r=20)
txt(90,240,'共同入口：平台验证身份、企业与会话，并固定模式',25,'#226780',700)
txt(90,274,'BUILDER → kvvi-builder（搭建工具）     USER → kvvi-worker（业务工具）     每次实际操作仍由平台重新判定权限',22,'#536b7f')

for p,(title,subtitle) in enumerate([('01  搭建闭环','搭建者 + Builder Agent + LLM + Skills'),('02  发布闭环','搭建者确认提交 → 所有者审批发布'),('03  使用闭环','员工 + Worker Agent + 业务平台 API')]):
    x=panels[p]
    rect(x,344,600,1096,bg[p],r=24)
    txt(x+28,393,title,33,colors[p],700)
    txt(x+28,428,subtitle,21,'#65788a')

card('b1',0,466,'需求与目标澄清',['缺少关键信息时询问搭建者'],'LLM')
card('b2',0,596,'先确定业务数据模型',['data-model：实体、字段、关系与状态'],'Skill')
card('b3',0,726,'按依赖生成业务定义',['表单 / 流程 / 看板 / 接口','可按依赖并行，不强制固定顺序'],'Skills',h=108)
card('b4',0,872,'生成并检查六类契约',['机器检查结构、引用与跨契约一致性'],'程序')
card('b5',0,1002,'预览与需求核对',['展示业务效果、规则及待确认项'],'搭建者')
card('b6',0,1132,'发布完整性检查',['六类齐全；多工具完整装订','多份非工具契约 → 阻断并点名'],'程序',h=108)
for a,b in [('b1','b2'),('b2','b3'),('b3','b4'),('b4','b5'),('b5','b6')]:down(a,b,'通过' if a=='b4' else '')
loop('b4','b3',0,['校验','失败'])
loop('b5','b1',0,['需求','修订'],side='left')
rect(88,1281,534,108,'#ffffff',r=15)
txt(110,1316,'交接 ①：提交这份内容，不交接聊天历史',22,colors[0],700)
txt(110,1350,'校验通过 ≠ 业务需求正确；预览核对仍需人参与。',19,'#63798d')

card('p1',1,466,'告知提交内容并确认调用',['publish_submit 通过执行前确认闸'],'搭建者')
card('p2',1,596,'平台保存草案与差异报告',['保存契约内容，并绑定变更摘要'],'平台')
card('p3',1,726,'所有者审阅差异与审批',['核对同一份内容；提出者不得自审批'],'所有者',h=108)
card('p4',1,872,'重新检查后执行发布',['契约、策略、系统信息同事务写入'],'平台')
card('p5',1,1002,'编译已发布运行时投影',['检查必需契约、字段与状态绑定'],'平台')
card('p6',1,1132,'员工工作台读取已发布系统',['工作模式只能使用已发布业务能力'],'平台',h=108)
for a,b in [('p1','p2'),('p2','p3'),('p3','p4'),('p4','p5'),('p5','p6')]:down(a,b,'批准' if a=='p3' else '')
rect(722,1281,534,108,'#ffffff',r=15)
txt(744,1316,'驳回 → 回搭建闭环修改 → 提交新草案',22,colors[1],700)
txt(744,1350,'审批不扩大基础权限，发布不替代运行时权限检查。',19,'#63798d')

card('w1',2,466,'理解员工请求并补充信息',['读取结构、记录和可执行动作'],'LLM')
card('w2',2,596,'选择操作并准备准确参数',['查询 / 单条创建更新直接继续','流程动作携带记录版本'],'Agent')
card('w3',2,726,'流程变更逐次确认',['绑定身份、记录、动作与版本','一次批准才执行；取消 / 无应答则拒绝'],'执行器',h=108)
card('w4',2,872,'业务工具调用平台 API',['检查身份、动作权限、行字段与流程状态'],'平台')
card('w5',2,1002,'执行操作并留下审计',['返回实际结果或明确拒绝原因'],'平台')
card('w6',2,1132,'解释结果并决定是否继续',['成功 → 返回结果；拒绝 → 说明原因','需要更多信息 / 版本冲突 → 重读后判断'],'LLM',h=108)
for a,b in [('w1','w2'),('w2','w3'),('w3','w4'),('w4','w5'),('w5','w6')]:down(a,b)
# Reads and ordinary single-record writes bypass the workflow confirmation.
# Workflow transitions require a one-shot decision inside the executor.
x,y,w,h=cards['w2'];xx,yy,ww,hh=cards['w4']
rail=panels[2]+54
arrow([(x,y+h/2),(rail,y+h/2),(rail,yy+hh/2),(xx,yy+hh/2)],colors[2],True)
txt(rail-8,752,'查询',16,colors[2],400,'end')
txt(rail-8,777,'普通',16,colors[2],400,'end')
txt(rail-8,802,'读写',16,colors[2],400,'end')
loop('w6','w1',2,['重读','继续'])
rect(1357,1281,534,108,'#ffffff',r=15)
txt(1379,1316,'权限拒绝必须解释，不自行改路绕过',22,colors[2],700)
txt(1379,1350,'重试有边界；重新读取不等于自动重复写入。',19,'#63798d')

# The arrows between panel headings represent separate role/session handoffs.
arrow([(642,370),(700,370)],'#8ba0b0')
arrow([(1277,370),(1335,370)],'#8ba0b0')

rect(55,1473,1870,283,'#f5f8fb',r=22)
txt(86,1516,'如何读这张图',27,'#17687b',700)
txt(86,1558,'实线：已落地的执行链路    回路线：失败修订 / 获取更多信息    三个闭环通过内容与结果交接',23,'#50677c')
txt(86,1602,'共同原则',22,'#26394e',700)
txt(250,1602,'Skill 提供方法；LLM 理解与生成；Agent 编排工具；平台承担权限检查、实际执行与审计。',22,'#62758a')
txt(86,1646,'长任务边界',22,'#26394e',700)
txt(250,1646,'原认证身份绑定到同进程的 Agent / Session；每次平台操作重验权限。进程重启后的续跑必须先重新认证。',22,'#62758a')
txt(86,1690,'发布完整性',22,'#26394e',700)
txt(250,1690,'每类非工具契约当前只允许一份，多份将拒绝提交；多工具完整装订。多视图 / 多模型存储仍待扩展。',22,'#62758a')
txt(86,1730,'2026-10-13 实现更新版 / 代码基线 efde7293 + 本次修补 / 尚未部署。不新增批量、删除、付款、聚合或图表运行能力。',18,'#8091a1')
parts.append('</svg>')
path=OUT/'KVVI-Agent-三闭环实现流程.svg'
path.write_text('\n'.join(parts),encoding='utf-8')
print(path)
