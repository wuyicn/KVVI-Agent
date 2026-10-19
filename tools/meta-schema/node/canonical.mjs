/**
 * Importable kvvi-json-c14n/v1 adapter for trusted catalog/reference consumers.
 * Derived from the independently frozen Node reference at
 * protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/node/kvvi-json-c14n.mjs.
 * The frozen reference and vectors remain unchanged. This module does no I/O.
 * Pass original JSON text/bytes: JSON.parse/stringify before validation loses
 * duplicate keys and exact numeric tokens. Decimal business values use strings.
 */
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const PROFILE = "kvvi-json-c14n/v1";
const SAFE_INTEGER_LIMIT = 9007199254740991n;


export class CanonicalizationError extends Error {
  constructor(errorCode) {
    super(errorCode);
    this.errorCode = errorCode;
  }
}


class JsonNumber {
  constructor(token) {
    this.token = token;
  }
}


class JsonObject {
  constructor(entries) {
    this.entries = entries;
  }
}


class StrictJsonParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      throw new CanonicalizationError("CANON_JSON_INVALID");
    }
    return value;
  }

  skipWhitespace() {
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") {
        break;
      }
      this.index += 1;
    }
  }

  parseValue() {
    const character = this.text[this.index];
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === '"') return this.parseString();
    if (character === "t") return this.parseLiteral("true", true);
    if (character === "f") return this.parseLiteral("false", false);
    if (character === "n") return this.parseLiteral("null", null);
    if (character === "-" || (character >= "0" && character <= "9")) {
      return this.parseNumber();
    }
    throw new CanonicalizationError("CANON_JSON_INVALID");
  }

  parseObject() {
    this.index += 1;
    const entries = new Map();
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return new JsonObject(entries);
    }

    while (true) {
      if (this.text[this.index] !== '"') {
        throw new CanonicalizationError("CANON_JSON_INVALID");
      }
      const key = this.parseString();
      if (entries.has(key)) {
        throw new CanonicalizationError("CANON_DUPLICATE_KEY");
      }
      this.skipWhitespace();
      if (this.text[this.index] !== ":") {
        throw new CanonicalizationError("CANON_JSON_INVALID");
      }
      this.index += 1;
      this.skipWhitespace();
      entries.set(key, this.parseValue());
      this.skipWhitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return new JsonObject(entries);
      }
      if (this.text[this.index] !== ",") {
        throw new CanonicalizationError("CANON_JSON_INVALID");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  parseArray() {
    this.index += 1;
    const values = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return values;
    }

    while (true) {
      values.push(this.parseValue());
      this.skipWhitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return values;
      }
      if (this.text[this.index] !== ",") {
        throw new CanonicalizationError("CANON_JSON_INVALID");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  parseLiteral(token, value) {
    if (this.text.slice(this.index, this.index + token.length) !== token) {
      throw new CanonicalizationError("CANON_JSON_INVALID");
    }
    this.index += token.length;
    return value;
  }

  parseNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.text.slice(this.index),
    );
    if (match === null) {
      throw new CanonicalizationError("CANON_JSON_INVALID");
    }
    this.index += match[0].length;
    return new JsonNumber(match[0]);
  }

  parseString() {
    this.index += 1;
    const parts = [];
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      const codeUnit = this.text.charCodeAt(this.index);
      if (character === '"') {
        this.index += 1;
        return parts.join("");
      }
      if (character === "\\") {
        this.index += 1;
        parts.push(this.parseEscape());
        continue;
      }
      if (codeUnit <= 0x1f) {
        throw new CanonicalizationError("CANON_JSON_INVALID");
      }
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const low = this.text.charCodeAt(this.index + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) {
          throw new CanonicalizationError("CANON_INVALID_UNICODE");
        }
        parts.push(this.text.slice(this.index, this.index + 2));
        this.index += 2;
        continue;
      }
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        throw new CanonicalizationError("CANON_INVALID_UNICODE");
      }
      parts.push(character);
      this.index += 1;
    }
    throw new CanonicalizationError("CANON_JSON_INVALID");
  }

  parseEscape() {
    const escape = this.text[this.index];
    this.index += 1;
    const simpleEscapes = new Map([
      ['"', '"'],
      ["\\", "\\"],
      ["/", "/"],
      ["b", "\b"],
      ["f", "\f"],
      ["n", "\n"],
      ["r", "\r"],
      ["t", "\t"],
    ]);
    if (simpleEscapes.has(escape)) {
      return simpleEscapes.get(escape);
    }
    if (escape !== "u") {
      throw new CanonicalizationError("CANON_JSON_INVALID");
    }

    const first = this.readHexCodeUnit();
    if (first >= 0xd800 && first <= 0xdbff) {
      if (this.text[this.index] !== "\\" || this.text[this.index + 1] !== "u") {
        throw new CanonicalizationError("CANON_INVALID_UNICODE");
      }
      this.index += 2;
      const second = this.readHexCodeUnit();
      if (!(second >= 0xdc00 && second <= 0xdfff)) {
        throw new CanonicalizationError("CANON_INVALID_UNICODE");
      }
      return String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00));
    }
    if (first >= 0xdc00 && first <= 0xdfff) {
      throw new CanonicalizationError("CANON_INVALID_UNICODE");
    }
    return String.fromCharCode(first);
  }

  readHexCodeUnit() {
    const digits = this.text.slice(this.index, this.index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
      throw new CanonicalizationError("CANON_JSON_INVALID");
    }
    this.index += 4;
    return Number.parseInt(digits, 16);
  }
}


function parseIntegerToken(token) {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (match === null) {
    throw new CanonicalizationError("CANON_NUMBER_UNSUPPORTED");
  }

  const negative = match[1] === "-";
  const fraction = match[3] ?? "";
  const exponent = BigInt(match[4] ?? "0");
  let digits = `${match[2]}${fraction}`.replace(/^0+/, "");
  if (digits === "") return 0n;

  const scale = BigInt(fraction.length) - exponent;
  if (scale > 0n) {
    if (scale >= BigInt(digits.length)) {
      throw new CanonicalizationError("CANON_NUMBER_UNSUPPORTED");
    }
    const scaleNumber = Number(scale);
    if (!digits.endsWith("0".repeat(scaleNumber))) {
      throw new CanonicalizationError("CANON_NUMBER_UNSUPPORTED");
    }
    digits = digits.slice(0, digits.length - scaleNumber).replace(/^0+/, "") || "0";
  } else if (scale < 0n) {
    const zeroCount = -scale;
    if (BigInt(digits.length) + zeroCount > 16n) {
      throw new CanonicalizationError("CANON_NUMBER_OUT_OF_RANGE");
    }
    digits += "0".repeat(Number(zeroCount));
  }

  const magnitude = BigInt(digits);
  if (magnitude > SAFE_INTEGER_LIMIT) {
    throw new CanonicalizationError("CANON_NUMBER_OUT_OF_RANGE");
  }
  return negative ? -magnitude : magnitude;
}


function escapeString(value) {
  const pieces = ['"'];
  const shortEscapes = new Map([
    ['"', '\\"'],
    ["\\", "\\\\"],
    ["\b", "\\b"],
    ["\t", "\\t"],
    ["\n", "\\n"],
    ["\f", "\\f"],
    ["\r", "\\r"],
  ]);
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new CanonicalizationError("CANON_INVALID_UNICODE");
    }
    if (shortEscapes.has(character)) {
      pieces.push(shortEscapes.get(character));
    } else if (codePoint <= 0x1f) {
      pieces.push(`\\u${codePoint.toString(16).padStart(4, "0")}`);
    } else {
      pieces.push(character);
    }
  }
  pieces.push('"');
  return pieces.join("");
}


function canonicalize(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (value instanceof JsonNumber) return parseIntegerToken(value.token).toString(10);
  if (typeof value === "string") return escapeString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value instanceof JsonObject) {
    const keys = [...value.entries.keys()].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
    const members = keys.map((key) => `${escapeString(key)}:${canonicalize(value.entries.get(key))}`);
    return `{${members.join(",")}}`;
  }
  throw new CanonicalizationError("CANON_JSON_INVALID");
}


export function canonicalizeJson(rawText, profile = PROFILE) {
  if (profile !== PROFILE) {
    throw new CanonicalizationError("CANON_PROFILE_UNSUPPORTED");
  }
  if (typeof rawText !== "string") {
    throw new CanonicalizationError("CANON_JSON_INVALID");
  }
  const parsed = new StrictJsonParser(rawText).parse();
  const canonical = canonicalize(parsed);
  const canonicalBytes = Buffer.from(canonical, "utf8");
  return {
    status: "ok",
    profile: PROFILE,
    canonical,
    canonical_utf8_hex: canonicalBytes.toString("hex"),
    digest: `sha256:${createHash("sha256").update(canonicalBytes).digest("hex")}`,
  };
}


/** Strict UTF-8 ingress; TextDecoder would otherwise strip a leading BOM. */
export function canonicalizeBytes(bytes, profile = PROFILE) {
  if (!(bytes instanceof Uint8Array)) throw new CanonicalizationError("CANON_JSON_INVALID");
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new CanonicalizationError("CANON_JSON_INVALID");
  }
  let rawText;
  try {
    rawText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CanonicalizationError("CANON_INVALID_UNICODE");
  }
  return canonicalizeJson(rawText, profile);
}
