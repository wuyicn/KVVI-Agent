/** FIX2 auxiliary lexical secret detection; never validates or uses credentials. */
import { diagnostic, sortedUnique } from './diagnostics.mjs';
import { childPath, DYNAMIC, isObject } from './view_safety.mjs';

const PATTERNS = [
  /-----begin (?:(?:rsa|ec|dsa|openssh|encrypted) )?private key-----/u,
  /(?:^|[^a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^ \t\r\n/?#:@]+:[^ \t\r\n/?#@]+@[^ \t\r\n/?#]+/u,
  /(?:^|[^a-z0-9_])(?:password|passwd|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key)["']?[ \t\r\n]*[:=][ \t\r\n]*["']?[^ \t\r\n"'=:,;{}\[\]]+/u,
  /(?:^|[^a-z0-9_])bearer[ \t\r\n]+[a-z0-9._~+/-]+=*/u,
];

export function looksSecret(value) {
  const folded = value.replace(/[A-Z]/gu, c => String.fromCharCode(c.charCodeAt(0) + 32));
  return PATTERNS.some(pattern => pattern.test(folded));
}

export function validateSecrets(spec, prefix) {
  const errors = [];
  // Rendered dictionary prefixes lack raw-key provenance; redact conservatively.
  const stack = [[spec, prefix, false, prefix.includes('["') || looksSecret(prefix)]];
  while (stack.length) {
    const [value, path, dynamic, tainted] = stack.pop();
    if (typeof value === 'string' && looksSecret(value)) {
      errors.push(diagnostic('SECRET_DETECTED', tainted ? '$' : path));
    } else if (isObject(value)) {
      for (const [key, item] of Object.entries(value).reverse())
        stack.push([item, childPath(path, key, dynamic),
          DYNAMIC.has(key) || (dynamic && (path.endsWith('.i18n') || path === 'i18n')),
          tainted || looksSecret(key)]);
    } else if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--)
        stack.push([value[i], childPath(path, i), false, tainted]);
    }
  }
  return sortedUnique(errors);
}
