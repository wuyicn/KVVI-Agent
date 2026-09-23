/** Iterative View preflight before recursive schemas; strings are never executed. */
import { diagnostic, sortedUnique } from "./diagnostics.mjs";

const RAW_KEYS = new Set([
  "JSExpression",
  "JSFunction",
  "script",
  "html",
  "css",
  "style",
  "styles",
  "methods",
  "utils",
  "lifeCycles",
  "lifecycle",
  "package",
  "npm",
  "exportName",
  "componentsMap",
  "cdn",
  "render",
  "dangerouslySetInnerHTML",
  "innerHTML",
]);
const DATA_KEYS = new Set([
  "url",
  "uri",
  "headers",
  "header",
  "token",
  "sql",
  "graphql",
  "dataSource",
  "request",
  "fetch",
  "requestFunction",
]);
export const DYNAMIC = new Set(["props", "actions", "input", "params", "i18n"]);
// view-static-lexical-r1: controller ruling 17, documented in VIEW.md.
const SCANNER_SPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const SPACE = `[${SCANNER_SPACE}]`;
const MARKUP = new RegExp(String.raw`<${SPACE}*(?:/?[a-z][^>]*|!|\?)>|javascript${SPACE}*:|data${SPACE}*:${SPACE}*text/html`, 'u');
const CALL = new RegExp(String.raw`function${SPACE}*(?:[A-Za-z_$][A-Za-z0-9_$]*${SPACE}*)?\(|(?:eval|Function|import)${SPACE}*\(`, 'gu');
const DATA = new RegExp(String.raw`^${SPACE}*(?:https?://|(?:select|insert|update|delete)${SPACE}+|(?:query|mutation)${SPACE}*[{(])`, 'u');
function stringSafetyCode(value, path) {
  const folded=value.replace(/[A-Z]/gu,c=>String.fromCharCode(c.charCodeAt(0)+32));
  if(MARKUP.test(folded))return 'VIEW_RAW_CODE_FORBIDDEN';
  // Dictionary-key spelling cannot promote an inert message to a code position.
  if(/^(?:spec\.)?i18n\[/u.test(path))return null;
  if(!/\.(?:props|input|params)\[|\.condition(?:\.|$)/u.test(path))return null;
  if(value.includes('=>'))return 'VIEW_RAW_CODE_FORBIDDEN';
  for(const match of value.matchAll(CALL)) {
    const before=match.index===0?null:value[match.index-1];
    if(before===null || SCANNER_SPACE.includes(before) || (before.charCodeAt(0)<128 && !/[A-Za-z0-9_$]/u.test(before)))
      return 'VIEW_RAW_CODE_FORBIDDEN';
  }
  return path.includes('.params[') && DATA.test(folded)?'VIEW_DATA_SOURCE_FORBIDDEN':null;
}
export const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
// Only dictionary containers, not an illegal object-valued message.
export const isI18nPath = (path) =>
  /^(?:spec\.)?i18n(?:\["(?:[^"\\]|\\.)*"\])?$/u.test(path);

export function childPath(path, key, dynamic = false) {
  const base = path === "$" ? "" : path;
  if (typeof key === "number") return `${base}[${key}]`;
  if (dynamic || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
    return `${base}[${JSON.stringify(key)}]`;
  return `${base}${base ? "." : ""}${key}`;
}

export function* walk(value, prefix = "") {
  const stack = [[value, prefix, false]];
  while (stack.length) {
    const [current, path, dynamic] = stack.pop();
    yield [current, path];
    if (isObject(current)) {
      for (const [key, item] of Object.entries(current).reverse())
        stack.push([
          item,
          childPath(path, key, dynamic),
          DYNAMIC.has(key) ||
            (dynamic && (path.endsWith(".i18n") || path === "i18n")),
        ]);
    } else if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--)
        stack.push([current[i], childPath(path, i), false]);
    }
  }
}

function expressionOverBudget(root) {
  let leaves = 0;
  const stack = [[root, 1]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (depth > 3) return true;
    if (!isObject(value)) continue;
    if (Object.hasOwn(value, "left")) leaves++;
    if (leaves > 20) return true;
    for (const key of ["all", "any"]) {
      if (Array.isArray(value[key])) {
        if (value[key].length > 20) return true;
        for (const child of value[key]) stack.push([child, depth + 1]);
      }
    }
    if (Object.hasOwn(value, "not")) stack.push([value.not, depth + 1]);
  }
  return false;
}

export function viewPreflight(spec, prefix = "") {
  if (!isObject(spec)) return [];
  const errors = [];
  for (const [value, path] of walk(spec, prefix)) {
    if (isObject(value) && !isI18nPath(path)) {
      for (const key of Object.keys(value)) {
        const code = RAW_KEYS.has(key)
          ? "VIEW_RAW_CODE_FORBIDDEN"
          : DATA_KEYS.has(key)
            ? "VIEW_DATA_SOURCE_FORBIDDEN"
            : null;
        if (code)
          errors.push(
            diagnostic(
              code,
              childPath(
                path,
                key,
                /\.(props|actions|input|params)$/u.test(path) ||
                  DYNAMIC.has(path),
              ),
            ),
          );
      }
      if (["JSExpression", "JSFunction"].includes(value.type))
        errors.push(diagnostic("VIEW_RAW_CODE_FORBIDDEN", path));
    } else if (typeof value === "string") {
      const code=stringSafetyCode(value,path);
      if(code)errors.push(diagnostic(code,path));
    }
  }
  if (errors.length) return sortedUnique(errors);
  const stack = Array.isArray(spec.componentsTree)
    ? spec.componentsTree.map((n) => [n, 1])
    : [];
  let count = 0;
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (++count > 500 || depth > 20) {
      errors.push(
        diagnostic("VIEW_LIMIT_EXCEEDED", childPath(prefix, "componentsTree")),
      );
      break;
    }
    if (isObject(node) && Array.isArray(node.children))
      for (const child of node.children) stack.push([child, depth + 1]);
  }
  const expressionPaths = [];
  for (const [value, path] of walk(spec, prefix)) {
    if (
      expressionPaths.some(
        (parent) =>
          path.startsWith(parent + ".") || path.startsWith(parent + "["),
      )
    )
      continue;
    if (
      isObject(value) &&
      !isI18nPath(path) &&
      (value.type === "SafeExpression" ||
        ["all", "any", "not", "left"].some((k) => Object.hasOwn(value, k))) &&
      expressionOverBudget(value)
    ) {
      errors.push(diagnostic("VIEW_EXPRESSION_UNSAFE", path));
      expressionPaths.push(path);
    }
  }
  if (errors.length) return sortedUnique(errors);
  // Key order changes no byte count; integer/Unicode domain was checked by c14n.
  if (Buffer.byteLength(JSON.stringify(spec), "utf8") > 1048576)
    return [diagnostic("VIEW_LIMIT_EXCEEDED", prefix)];
  if (isObject(spec.i18n))
    for (const [locale, messages] of Object.entries(spec.i18n)) {
      if (isObject(messages))
        for (const key of Object.keys(messages)) {
          const length = [...key].length;
          const path = childPath(
            childPath(childPath(prefix, "i18n"), locale, true),
            key,
            true,
          );
          if (length > 128)
            errors.push(diagnostic("VIEW_LIMIT_EXCEEDED", path));
          else if (length === 0)
            errors.push(diagnostic("VIEW_PROP_INVALID", path));
        }
    }
  return sortedUnique(errors);
}
