/**
 * 进程身份自述：本进程实际加载了什么，以及**为什么能证明它加载不了插件**。
 *
 * 这一层的用途是锚点⑥ 的取证。PRD §9.4.1 要求「平台服务进程不加载任何插件」
 * 是**可核验的启动配置**，不是意愿声明 —— 所以本模块只报告能被外部独立复核的
 * 事实，不报告任何自我评价：
 *
 *   · dshPackagesPresent —— 文件系统里到底有没有 @deepseek-ai/* 包。
 *     这是本证据链的锚：**没有包，就不存在加载插件的可能**，
 *     而不是「我们选择不加载」。前者是能力缺失，后者是纪律，二者强度不同。
 *   · pluginLoaderImports —— 本进程源码里有没有 import 过插件加载器。
 *   · importedModules —— 本进程实际 import 的模块全集（运行时事实）。
 *
 * 明确不报告「插件数为 0」这类自证式数字作为唯一依据 —— 一个进程当然可以
 * 谎报自己的插件数。真正的证据是上面三条能被外部独立验证的事实。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SERVICE_ROOT = resolve(HERE, '..')

/** npm scope 下的 DSH 包前缀。出现任意一个即说明本进程有能力加载插件。 */
const DSH_SCOPE = '@deepseek-ai'

/** 插件加载器家族：cordis 加载器与 DSH 的 loader/boot 包。 */
const LOADER_PATTERN = /cordis|plugin-loader|app-boot|dsh-loader/u

/**
 * 剥掉源码里的注释，避免把注释或正则字面量里的 `import` 当成真 import。
 *
 * 这不是洁癖：本文件的注释与正则里都出现过 `import` 字样，未剥注释时
 * 扫描结果里混进了一句注释文本。**取证工具自己产出假数据**，
 * 比没有取证工具更坏 —— 它带着「已核验」的外观。
 * @param text - 源文件全文。
 * @returns 去掉块注释与行注释后的文本，换行数保持不变。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/gu, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

/**
 * 本进程源码里 import 的模块全集（静态事实）。
 *
 * **只报静态结果，不报运行时模块图**：ESM 下模块图无法从进程内枚举
 * （`require.cache` 只含 CJS 半边，对本服务恒为空）。先前版本报了一个
 * 恒为空的 `runtime` 字段 —— 那会让读者以为「运行时没有模块」，是**反向误导**，
 * 故已删除。规则：**报不出来的东西不报，而不是报一个空值**。
 * @returns {string[]} 去重排序后的模块说明符；相对导入会保留原样。
 */
export function importedModules() {
  const fromSource = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.m?js$/u.test(entry.name)) continue
      // 行首锚定 + 剥注释：一个匹配要成立，必须是一行的开头就是 import 语句。
      // 用宽松的 `.*import` 会把注释、字符串与正则字面量一并卷进来。
      const text = stripComments(readFileSync(full, 'utf8'))
      for (const m of text.matchAll(/^[ \t]*import\s+(?:[^'"\n]*?\sfrom\s+)?['"]([^'"]+)['"]/gmu)) {
        fromSource.push(m[1])
      }
    }
  }
  walk(resolve(SERVICE_ROOT, 'src'))
  return [...new Set(fromSource)].sort()
}

/**
 * 文件系统里是否存在任何 DSH 包。
 *
 * 查找顺序是**向外**的：本服务目录 → 仓库根。任何一层有 @deepseek-ai
 * 都算存在 —— 因为 Node 的解析规则同样会向外走，所以「本目录没有」不足以证明
 * 「解析不到」。只查本目录会给出过强的结论。
 * @returns {{ present: boolean, searched: string[], foundIn: string | null }} 查找结果与查找过的路径。
 */
export function dshPackagesPresent() {
  const searched = []
  let dir = SERVICE_ROOT
  for (;;) {
    const candidate = resolve(dir, 'node_modules', DSH_SCOPE)
    searched.push(candidate)
    if (existsSync(candidate)) {
      const names = readdirSync(candidate)
      return { present: true, searched, foundIn: `${candidate} (${names.length} 个包)` }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { present: false, searched, foundIn: null }
}

/** 源码里 import 过的插件加载器。空数组即「本进程从未 import 加载器」。 */
export function pluginLoaderImports() {
  return importedModules().filter((name) => LOADER_PATTERN.test(name))
}

/** 朗读本服务的 package.json 依赖声明（应为空）。 */
export function declaredDependencies() {
  const pkg = JSON.parse(readFileSync(resolve(SERVICE_ROOT, 'package.json'), 'utf8'))
  return { dependencies: Object.keys(pkg.dependencies ?? {}), devDependencies: Object.keys(pkg.devDependencies ?? {}) }
}

/**
 * 组装完整的取证快照。
 *
 * `pluginsLoaded` 由 `dshPackagesPresent` 与 `pluginLoaderImports` **推导**，
 * 不由本进程直接断言 —— 推导链可以被外部复核，断言不能。
 * @returns 取证快照对象。
 */
export function topologySnapshot() {
  const dsh = dshPackagesPresent()
  const loaders = pluginLoaderImports()
  const deps = declaredDependencies()
  const fromSource = importedModules()

  return {
    process: 'platform-service',
    role: '身份层 / 授权判定 / 签名模块 / 发布通道 / 平台库访问 / 认证端点',
    pluginsLoaded: dsh.present || loaders.length > 0 ? null : 0,
    evidence: {
      dshPackagesPresent: dsh.present,
      dshPackagesSearched: dsh.searched,
      dshPackagesFoundIn: dsh.foundIn,
      pluginLoaderImports: loaders,
      declaredDependencies: deps.dependencies,
      declaredDevDependencies: deps.devDependencies,
      importedFromSource: fromSource,
    },
    // 这些是给读者看的口径声明，不是证据；证据在上面的 evidence 里。
    notes: [
      'pluginsLoaded 由 dshPackagesPresent 与 pluginLoaderImports 推导，非本进程断言。',
      '本进程不引入任何 DSH 包，因此「不加载插件」是能力缺失而非纪律承诺。',
      '节点私钥不进入镜像：由运行期挂载或外部 KMS 提供，见 services/platform/README.md。',
      '不报运行时模块图：ESM 下无法从进程内枚举，报空值会反向误导。',
    ],
  }
}
