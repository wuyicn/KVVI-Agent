/**
 * 把工具侧（`vendor/dsh/packages/tool/kvvi-publish`）的契约装订决定
 * 按一棵给定的树算出来，打成 JSON 给 Python 侧对拍。
 *
 * ## 为什么要有这个文件
 *
 * 「CLI 脚手架」与「Agent 工具」两条路都会把工作区里的契约发上平台，
 * 而两处注释都写着「必须同源」—— 却**没有任何东西在管**。
 * 不同源的表现是：同一次构建，经由 CLI 与经由 Agent 会发上去**不同的东西**，
 * 而两边都只报「缺某一份」，看不出是判据漂移。
 *
 * 只输出**决定**，不输出措辞：两侧的注记文字本来就是给不同读者看的
 * （一边是命令行的人，一边是模型），措辞不同不是缺陷，
 * 认成哪一类、挑中哪一份、跳过哪些目录才是。
 *
 * `skipped` 取的是**扫描自己的输出**，不是从注记文字里正则抠回来的 ——
 * 抠文字的话，两侧同时漏报时对拍照样绿，而漏报正是要防的那件事。
 * 「注记里说了没有」单独用一个字段报，由闸门分开判。
 *
 * 用法：`node --import tsx/esm 工具/lib/契约装订对拍.mjs <契约目录>`
 */

import { scanContractTree, readContracts } from '../../vendor/dsh/packages/tool/kvvi-publish/src/index.ts'
import { relative } from 'node:path'

const tree = process.argv[2]
if (tree === undefined) {
  console.error('用法：node --import tsx/esm 工具/lib/契约装订对拍.mjs <契约目录>')
  process.exit(2)
}

const { found, skipped } = scanContractTree(tree)
const { notes } = readContracts(tree)

const candidates = {}
const picked = {}
for (const [type, paths] of Object.entries(found)) {
  candidates[type] = paths.map((p) => relative(tree, p)).sort()
  // 被采用的那一份：`readContracts` 用的就是 `paths[0]`（按名字排序后）。
  picked[type] = paths.length === 0 ? null : relative(tree, paths[0])
}

process.stdout.write(JSON.stringify({
  candidates,
  picked,
  // 排序后再交出去：`os.walk` 与 `readdirSync().sort()` 的遍历顺序不同，
  // 不排序的话两侧会得到同样内容、不同顺序的结果，对拍分不清「不一致」和「只是顺序不同」。
  skipped: skipped.map((s) => [s.path, s.files]).sort(),
  skippedInNotes: skipped
    .filter((s) => notes.some((n) => n.includes('整目录跳过') && n.includes(s.path)))
    .map((s) => s.path)
    .sort(),
}))
