"""Safe pattern parser and O(pattern atoms * input codepoints) matcher.

No user pattern is ever passed to a regex engine. Repetition bounds are kept as
decimal strings until capped by the input length, avoiding expansion attacks.
"""

from dataclasses import dataclass

SPACES = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


@dataclass(frozen=True)
class SafePattern:
    valid: bool
    atoms: tuple = ()
    start: bool = False
    end: bool = False


def parse_safe_pattern(pattern):
    if not isinstance(pattern, str) or len(pattern) > 200:
        return SafePattern(False)
    i = 0
    atoms = []
    start = pattern.startswith("^")
    end = False
    if start:
        i = 1

    def escaped(pos):
        if pos >= len(pattern):
            raise ValueError()
        c = pattern[pos]
        if c in "dDwWsS":
            return ("set", c), pos + 1
        literals = {"n": "\n", "r": "\r", "t": "\t", "f": "\f", "v": "\v"}
        if c in literals:
            return ("literal", literals[c]), pos + 1
        if c in r"\.^$[]{}()*+?|-/":
            return ("literal", c), pos + 1
        raise ValueError()

    try:
        while i < len(pattern):
            c = pattern[i]
            i += 1
            if c == "$" and i == len(pattern):
                end = True
                break
            if c == "\\":
                atom, i = escaped(i)
            elif c == "[":
                neg = i < len(pattern) and pattern[i] == "^"
                if neg:
                    i += 1
                members = []
                while i < len(pattern) and pattern[i] != "]":
                    if pattern[i] == "\\":
                        first, i = escaped(i + 1)
                    else:
                        first = ("literal", pattern[i])
                        i += 1
                    if (
                        i < len(pattern)
                        and pattern[i] == "-"
                        and i + 1 < len(pattern)
                        and pattern[i + 1] != "]"
                    ):
                        i += 1
                        if pattern[i] == "\\":
                            last, i = escaped(i + 1)
                        else:
                            last = ("literal", pattern[i])
                            i += 1
                        if (
                            first[0] != "literal"
                            or last[0] != "literal"
                            or ord(first[1]) > ord(last[1])
                        ):
                            raise ValueError()
                        members.append(("range", (first[1], last[1])))
                    else:
                        members.append(first)
                if not members or i >= len(pattern):
                    raise ValueError()
                i += 1
                atom = ("class", (neg, tuple(members)))
            elif c == ".":
                atom = ("dot", None)
            elif c in "^$]()|*+?{}":
                raise ValueError()
            else:
                atom = ("literal", c)
            low = "1"
            high = "1"
            if i < len(pattern) and pattern[i] in "?*+":
                q = pattern[i]
                i += 1
                low = "1" if q == "+" else "0"
                high = "1" if q == "?" else None
            elif i < len(pattern) and pattern[i] == "{":
                i += 1
                begin = i
                while i < len(pattern) and pattern[i] in "0123456789":
                    i += 1
                if i == begin:
                    raise ValueError()
                low = pattern[begin:i].lstrip("0") or "0"
                high = low
                if i < len(pattern) and pattern[i] == ",":
                    i += 1
                    begin = i
                    while i < len(pattern) and pattern[i] in "0123456789":
                        i += 1
                    if i == begin:
                        raise ValueError()
                    high = pattern[begin:i].lstrip("0") or "0"
                if i >= len(pattern) or pattern[i] != "}":
                    raise ValueError()
                i += 1
                if (len(low), low) > (len(high), high):
                    raise ValueError()
            atoms.append((atom, low, high))
        return SafePattern(True, tuple(atoms), start, end)
    except ValueError:
        return SafePattern(False)


def _matches(atom, c):
    kind, value = atom
    if kind == "literal":
        return c == value
    if kind == "dot":
        return c not in "\n\r\u2028\u2029"
    if kind == "range":
        return value[0] <= c <= value[1]
    if kind == "class":
        neg, members = value
        matched = any(_matches(member, c) for member in members)
        return not matched if neg else matched
    base = value.lower()
    matched = (
        "0" <= c <= "9"
        if base == "d"
        else (
            c in SPACES
            if base == "s"
            else "a" <= c <= "z" or "A" <= c <= "Z" or "0" <= c <= "9" or c == "_"
        )
    )
    return not matched if value.isupper() else matched


def match_safe_pattern(parsed, text):
    if not parsed.valid:
        return False
    n = len(text)
    possible = [not parsed.start or j == 0 for j in range(n + 1)]

    def cap(number):
        if number is None:
            return n + 1
        return min(int(number), n + 1)  # pattern <=200 digits, never expanded

    for atom, lo, hi in parsed.atoms:
        low, high = cap(lo), cap(hi)
        prefix = [0]
        for yes in possible:
            prefix.append(prefix[-1] + int(yes))
        next_positions = [False] * (n + 1)
        streak = 0
        for end in range(n + 1):
            if end:
                streak = streak + 1 if _matches(atom, text[end - 1]) else 0
            left = max(0, end - high, end - streak)
            right = end - low
            if right >= left:
                next_positions[end] = prefix[right + 1] > prefix[left]
        possible = next_positions
    return possible[n] if parsed.end else any(possible)
