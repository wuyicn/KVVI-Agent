"""FIX2 auxiliary lexical secret detection; no credential validation or I/O."""
import re
from diagnostics import diagnostic, sorted_unique
from view_safety import child_path, DYNAMIC

_FOLD = str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
_PATTERNS = tuple(re.compile(pattern) for pattern in (
    r'-----begin (?:(?:rsa|ec|dsa|openssh|encrypted) )?private key-----',
    r'(?:^|[^a-z0-9+.-])[a-z][a-z0-9+.-]*://[^ \t\r\n/?#:@]+:[^ \t\r\n/?#@]+@[^ \t\r\n/?#]+',
    r'''(?:^|[^a-z0-9_])(?:password|passwd|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key)["']?[ \t\r\n]*[:=][ \t\r\n]*["']?[^ \t\r\n"'=:,;{}\[\]]+''',
    r'(?:^|[^a-z0-9_])bearer[ \t\r\n]+[a-z0-9._~+/-]+=*',
))


def looks_secret(value):
    folded = value.translate(_FOLD)
    return any(pattern.search(folded) for pattern in _PATTERNS)


def validate_secrets(spec, prefix):
    errors = []
    # A caller-supplied rendered prefix with dictionary keys has no raw-key
    # provenance here. Redact conservatively rather than re-scan JSON escapes.
    stack = [(spec, prefix, False, '["' in prefix or looks_secret(prefix))]
    while stack:
        value, path, dynamic, tainted = stack.pop()
        if isinstance(value, str) and looks_secret(value):
            errors.append(diagnostic('SECRET_DETECTED', '$' if tainted else path))
        elif isinstance(value, dict):
            for key, item in reversed(list(value.items())):
                stack.append((item, child_path(path, key, dynamic),
                              key in DYNAMIC or dynamic and (path.endswith('.i18n') or path == 'i18n'),
                              tainted or looks_secret(key)))
        elif isinstance(value, list):
            stack.extend((item, child_path(path, i), False, tainted)
                         for i, item in reversed(list(enumerate(value))))
    return sorted_unique(errors)
