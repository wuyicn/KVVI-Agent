/** RFC 5646 well-formed syntax, without IANA registry lookup or normalization. */
const GRANDFATHERED = new Set(
  "en-gb-oed i-ami i-bnn i-default i-enochian i-hak i-klingon i-lux i-mingo i-navajo i-pwn i-tao i-tay i-tsu sgn-be-fr sgn-be-nl sgn-ch-de art-lojban cel-gaulish no-bok no-nyn zh-guoyu zh-hakka zh-min zh-min-nan zh-xiang".split(
    " ",
  ),
);
const alpha = (s) => /^[a-z]+$/u.test(s);
const digits = (s) => /^[0-9]+$/u.test(s);
export function validLocale(tag) {
  if (typeof tag !== "string" || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(tag))
    return false;
  tag = tag.toLowerCase();
  if (GRANDFATHERED.has(tag)) return true;
  const parts = tag.split("-");
  if (parts.some((p) => p.length > 8)) return false;
  if (parts[0] === "x") return parts.length > 1;
  if (!alpha(parts[0]) || parts[0].length < 2 || parts[0].length > 8)
    return false;
  let i = 1;
  if (parts[0].length <= 3)
    for (let n = 0; n < 3; n++) {
      if (i < parts.length && parts[i].length === 3 && alpha(parts[i])) i++;
      else break;
    }
  if (i < parts.length && parts[i].length === 4 && alpha(parts[i])) i++;
  if (
    i < parts.length &&
    ((parts[i].length === 2 && alpha(parts[i])) ||
      (parts[i].length === 3 && digits(parts[i])))
  )
    i++;
  const variants = new Set();
  while (
    i < parts.length &&
    ((parts[i].length >= 5 && parts[i].length <= 8) ||
      (parts[i].length === 4 && digits(parts[i][0])))
  ) {
    if (variants.has(parts[i])) return false;
    variants.add(parts[i++]);
  }
  const singletons = new Set();
  while (i < parts.length && parts[i].length === 1 && parts[i] !== "x") {
    if (singletons.has(parts[i])) return false;
    singletons.add(parts[i++]);
    const start = i;
    while (i < parts.length && parts[i].length >= 2 && parts[i].length <= 8)
      i++;
    if (i === start) return false;
  }
  if (i < parts.length && parts[i] === "x") return i + 1 < parts.length;
  return i === parts.length;
}
