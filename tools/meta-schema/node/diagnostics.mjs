/** Deterministic diagnostics for the Node Meta-Schema implementation. */

const TEXT = new Map([
  ["SECRET_DETECTED", ["草案含疑似秘密信息", "移除秘密值，由受控密钥管理提供"]],
  ["PERMISSION_DECLARATION_FORBIDDEN", ["业务正文不得直接声明授权或可信身份", "移除注入声明，通过独立权限契约和可信上下文处理"]],
  ["UNKNOWN_PROPERTY", ["出现未登记属性", "移除未登记属性"]],
  [
    "CONTRACT_VERSION_UNSUPPORTED",
    ["契约版本不受支持", "使用受支持的固定契约版本"],
  ],
  ["CONTRACT_SHAPE_INVALID", ["契约结构不合法", "按所选入口修正契约结构"]],
  ["REFERENCE_INVALID", ["资源引用结构不合法", "提供完整且固定版本的资源引用"]],
  [
    "VIEW_CAPABILITY_REF_INVALID",
    ["能力引用结构不合法", "提供完整且固定版本的能力引用"],
  ],
  [
    "DEPENDENCY_VALIDATOR_UNAVAILABLE",
    ["依赖协议校验器尚不可用", "等待对应协议校验器实现后重试"],
  ],
  [
    "TRUSTED_CONTEXT_REQUIRED",
    ["完整校验需要独立可信上下文", "提供受信任的固定测试上下文"],
  ],
]);

export function diagnostic(code, path) {
  const [message, suggestedFix] = TEXT.get(code) ?? [
    "契约校验失败",
    "根据错误码修正输入后重试",
  ];
  return {
    code,
    severity: "ERROR",
    path: path || "$",
    message,
    suggested_fix: suggestedFix,
  };
}

export function sortedUnique(errors) {
  const unique = new Map();
  for (const error of errors) unique.set(`${error.path}\0${error.code}`, error);
  return [...unique.values()].sort((left, right) => {
    const pathOrder = Buffer.compare(
      Buffer.from(left.path),
      Buffer.from(right.path),
    );
    return pathOrder || left.code.localeCompare(right.code, "en");
  });
}

export function pointerPath(pointer, instance, view = false) {
  if (!pointer) return "$";
  const parts = pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let result = "";
  let current = instance;
  let dynamic = 0;
  for (const part of parts) {
    if (
      Array.isArray(current) ||
      (instance === undefined && /^(?:0|[1-9][0-9]*)$/.test(part))
    )
      result += `[${part}]`;
    else if (!dynamic && /^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
      result += `${result ? "." : ""}${part}`;
    else result += `[${JSON.stringify(part)}]`;
    current = current?.[part];
    dynamic = Math.max(0, dynamic - 1);
    if (view && ["props", "actions", "input", "params"].includes(part))
      dynamic = 1;
    else if (view && part === "i18n") dynamic = 2;
  }
  return result || "$";
}

export function appendProperty(path, property, dynamic = false) {
  if (dynamic)
    return `${path === "$" ? "" : path}[${JSON.stringify(property)}]`;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(property))
    return path === "$" ? property : `${path}.${property}`;
  return `${path === "$" ? "" : path}[${JSON.stringify(property)}]`;
}
