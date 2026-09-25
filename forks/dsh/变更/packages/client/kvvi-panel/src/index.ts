/**
 * KVVI 业务面板插件，**node 半**。
 *
 * 空的 `apply` 让 Loader 有一个 host 侧登记项，浏览器那一半通过
 * `exports["./client"]` 发布。本包只贡献浏览器呈现，不注册任何 host 服务 ——
 * 所以这里没有任何副作用需要回滚。
 */

/** Host 插件体 —— 本包只贡献浏览器呈现。 */
export function apply(): void {}
