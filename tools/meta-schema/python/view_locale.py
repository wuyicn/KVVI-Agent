"""RFC 5646 well-formed syntax, not IANA registry validity or canonicalization."""
import re

GRANDFATHERED = set("en-gb-oed i-ami i-bnn i-default i-enochian i-hak i-klingon i-lux i-mingo i-navajo i-pwn i-tao i-tay i-tsu sgn-be-fr sgn-be-nl sgn-ch-de art-lojban cel-gaulish no-bok no-nyn zh-guoyu zh-hakka zh-min zh-min-nan zh-xiang".split())


def valid_locale(tag):
    if not isinstance(tag, str) or not re.fullmatch(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*", tag):
        return False
    tag = tag.lower()
    if tag in GRANDFATHERED:
        return True
    parts = tag.split("-")
    if any(len(p) > 8 for p in parts):
        return False
    if parts[0] == "x":
        return len(parts) > 1
    if not parts[0].isalpha() or not 2 <= len(parts[0]) <= 8:
        return False
    i = 1
    if len(parts[0]) <= 3:
        for _ in range(3):
            if i < len(parts) and len(parts[i]) == 3 and parts[i].isalpha(): i += 1
            else: break
    if i < len(parts) and len(parts[i]) == 4 and parts[i].isalpha(): i += 1
    if i < len(parts) and (len(parts[i]) == 2 and parts[i].isalpha() or len(parts[i]) == 3 and parts[i].isdigit()): i += 1
    variants = set()
    while i < len(parts) and (5 <= len(parts[i]) <= 8 or len(parts[i]) == 4 and parts[i][0].isdigit()):
        if parts[i] in variants: return False
        variants.add(parts[i]); i += 1
    singletons = set()
    while i < len(parts) and len(parts[i]) == 1 and parts[i] != "x":
        if parts[i] in singletons: return False
        singletons.add(parts[i]); i += 1
        start = i
        while i < len(parts) and 2 <= len(parts[i]) <= 8: i += 1
        if i == start: return False
    if i < len(parts) and parts[i] == "x":
        return i + 1 < len(parts)
    return i == len(parts)
