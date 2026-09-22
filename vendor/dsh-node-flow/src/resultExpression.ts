const RESULT_TOKEN = /\{\{\s*((?:result|vars)(?:\s*(?:\.[A-Za-z_$][\w$]*|\[(?:\d+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\]))*)\s*\}\}/g

export function parseResultValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const source = value.trim()
  if (!source || (!source.startsWith('{') && !source.startsWith('['))) return value
  try {
    return JSON.parse(source)
  } catch {
    return value
  }
}

type ExpressionToken = { type: 'identifier' | 'number' | 'string' | 'operator' | 'punctuation' | 'eof'; value: string }

function tokenizeExpression(source: string): ExpressionToken[] {
  const tokens: ExpressionToken[] = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (/\s/.test(character)) { index += 1; continue }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index++
      while (index < source.length && /[\w$]/.test(source[index])) index += 1
      tokens.push({ type: 'identifier', value: source.slice(start, index) })
      continue
    }
    if (/\d/.test(character) || (character === '.' && /\d/.test(source[index + 1] ?? ''))) {
      const value = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/)?.[0]
      if (!value || !Number.isFinite(Number(value))) throw new Error('无效数字')
      tokens.push({ type: 'number', value })
      index += value.length
      continue
    }
    if (character === '"' || character === "'") {
      const quote = character
      index += 1
      let value = ''
      let closed = false
      while (index < source.length) {
        const next = source[index++]
        if (next === quote) { closed = true; break }
        if (next !== '\\') { value += next; continue }
        const escaped = source[index++]
        if (escaped === 'n') value += '\n'
        else if (escaped === 'r') value += '\r'
        else if (escaped === 't') value += '\t'
        else if (escaped === 'b') value += '\b'
        else if (escaped === 'f') value += '\f'
        else if (escaped === 'u') {
          const code = source.slice(index, index + 4)
          if (!/^[0-9a-f]{4}$/i.test(code)) throw new Error('无效 Unicode 转义')
          value += String.fromCharCode(Number.parseInt(code, 16))
          index += 4
        } else value += escaped
      }
      if (!closed) throw new Error('字符串未闭合')
      tokens.push({ type: 'string', value })
      continue
    }
    const operator = ['===', '!==', '>=', '<=', '&&', '||', '==', '!='].find((candidate) => source.startsWith(candidate, index))
    if (operator) {
      tokens.push({ type: 'operator', value: operator })
      index += operator.length
      continue
    }
    if ('><!+-*/%'.includes(character)) tokens.push({ type: 'operator', value: character })
    else if ('.()[],:'.includes(character)) tokens.push({ type: 'punctuation', value: character })
    else throw new Error(`不支持的表达式字符：${character}`)
    index += 1
  }
  tokens.push({ type: 'eof', value: '' })
  return tokens
}

function safeProperty(value: unknown, key: string | number): unknown {
  if (value === null || value === undefined || ['__proto__', 'prototype', 'constructor'].includes(String(key))) return undefined
  const property = Object(value)[key as keyof object]
  return typeof property === 'function' ? undefined : property
}

class ResultExpressionParser {
  private index = 0

  constructor(private readonly tokens: ExpressionToken[], private readonly result: unknown, private readonly variables: Record<string, unknown>) {}

  parse(): unknown {
    const value = this.parseOr()
    if (this.peek().type !== 'eof') throw new Error(`不支持的表达式片段：${this.peek().value}`)
    return value
  }

  private peek(): ExpressionToken { return this.tokens[this.index] }
  private take(): ExpressionToken { return this.tokens[this.index++] }
  private consume(value: string): boolean {
    if (this.peek().value !== value) return false
    this.index += 1
    return true
  }
  private expect(value: string): void {
    if (!this.consume(value)) throw new Error(`表达式需要 ${value}`)
  }

  private parseOr(): unknown {
    let value = this.parseAnd()
    while (this.consume('||')) {
      const right = this.parseAnd()
      value = value || right
    }
    return value
  }

  private parseAnd(): unknown {
    let value = this.parseEquality()
    while (this.consume('&&')) {
      const right = this.parseEquality()
      value = value && right
    }
    return value
  }

  private parseEquality(): unknown {
    let value = this.parseComparison()
    while (['===', '!==', '==', '!='].includes(this.peek().value)) {
      const operator = this.take().value
      const right = this.parseComparison()
      if (operator === '===') value = value === right
      else if (operator === '!==') value = value !== right
      else if (operator === '==') value = value == right
      else value = value != right
    }
    return value
  }

  private parseComparison(): unknown {
    let value = this.parseAdditive()
    while (['>', '>=', '<', '<='].includes(this.peek().value)) {
      const operator = this.take().value
      const right = this.parseAdditive()
      if (operator === '>') value = (value as never) > (right as never)
      else if (operator === '>=') value = (value as never) >= (right as never)
      else if (operator === '<') value = (value as never) < (right as never)
      else value = (value as never) <= (right as never)
    }
    return value
  }

  private parseAdditive(): unknown {
    let value = this.parseMultiplicative()
    while (['+', '-'].includes(this.peek().value)) {
      const operator = this.take().value
      const right = this.parseMultiplicative()
      value = operator === '+' ? (value as never) + (right as never) : Number(value) - Number(right)
    }
    return value
  }

  private parseMultiplicative(): unknown {
    let value = this.parseUnary()
    while (['*', '/', '%'].includes(this.peek().value)) {
      const operator = this.take().value
      const right = this.parseUnary()
      if (operator === '*') value = Number(value) * Number(right)
      else if (operator === '/') value = Number(value) / Number(right)
      else value = Number(value) % Number(right)
    }
    return value
  }

  private parseUnary(): unknown {
    if (this.consume('!')) return !this.parseUnary()
    if (this.consume('-')) return -Number(this.parseUnary())
    if (this.consume('+')) return Number(this.parseUnary())
    return this.parsePrimary()
  }

  private parsePrimary(): unknown {
    if (this.consume('(')) {
      const value = this.parseOr()
      this.expect(')')
      return this.parsePostfix(value)
    }
    const token = this.take()
    if (token.type === 'number') return this.parsePostfix(Number(token.value))
    if (token.type === 'string') return this.parsePostfix(token.value)
    if (token.type !== 'identifier') throw new Error('表达式不完整')
    if (token.value === 'true') return true
    if (token.value === 'false') return false
    if (token.value === 'null') return null
    if (token.value === 'undefined') return undefined
    if (token.value === 'result') return this.parsePostfix(this.result)
    if (token.value === 'vars') return this.parsePostfix(this.variables)
    if (['Number', 'String', 'Boolean'].includes(token.value)) {
      this.expect('(')
      const argument = this.parseOr()
      this.expect(')')
      const value = token.value === 'Number' ? Number(argument) : token.value === 'String' ? String(argument) : Boolean(argument)
      return this.parsePostfix(value)
    }
    if (token.value === 'JSON') {
      this.expect('.')
      if (this.take().value !== 'parse') throw new Error('只支持 JSON.parse')
      this.expect('(')
      const argument = this.parseOr()
      this.expect(')')
      return this.parsePostfix(JSON.parse(String(argument)))
    }
    if (token.value === 'Array') {
      this.expect('.')
      if (this.take().value !== 'isArray') throw new Error('只支持 Array.isArray')
      this.expect('(')
      const argument = this.parseOr()
      this.expect(')')
      return this.parsePostfix(Array.isArray(argument))
    }
    throw new Error(`不支持的标识符：${token.value}`)
  }

  private parsePostfix(initial: unknown): unknown {
    let value = initial
    while (true) {
      if (this.consume('.')) {
        const property = this.take()
        if (property.type !== 'identifier') throw new Error('属性名无效')
        if (this.consume('(')) {
          const args: unknown[] = []
          if (!this.consume(')')) {
            args.push(this.parseOr())
            while (this.consume(',')) args.push(this.parseOr())
            this.expect(')')
          }
          value = this.callMethod(value, property.value, args)
        } else value = safeProperty(value, property.value)
        continue
      }
      if (this.consume('[')) {
        const key = this.parseOr()
        this.expect(']')
        if (typeof key !== 'string' && typeof key !== 'number') throw new Error('属性索引必须是文本或数字')
        value = safeProperty(value, key)
        continue
      }
      return value
    }
  }

  private callMethod(value: unknown, method: string, args: unknown[]): unknown {
    if (method === 'includes' && (typeof value === 'string' || Array.isArray(value))) return value.includes(args[0] as never)
    if (method === 'startsWith' && typeof value === 'string') return value.startsWith(String(args[0] ?? ''))
    if (method === 'endsWith' && typeof value === 'string') return value.endsWith(String(args[0] ?? ''))
    if (method === 'trim' && typeof value === 'string' && args.length === 0) return value.trim()
    if (method === 'toLowerCase' && typeof value === 'string' && args.length === 0) return value.toLowerCase()
    if (method === 'toUpperCase' && typeof value === 'string' && args.length === 0) return value.toUpperCase()
    throw new Error(`不支持的方法：${method}`)
  }
}

export function evaluateResultExpression(expression: string, value: unknown, variables: Record<string, unknown> = {}): unknown {
  const source = expression.trim()
  if (source === 'result') return value
  const evaluate = (result: unknown): { ok: boolean; value?: unknown } => {
    try { return { ok: true, value: new ResultExpressionParser(tokenizeExpression(source), result, variables).parse() } }
    catch { return { ok: false } }
  }
  const parsed = parseResultValue(value)
  const useStructuredFirst = /\bresult\s*(?:\.|\[)/.test(expression) && !/\bJSON\.parse\s*\(\s*result\s*\)/.test(expression)
  const primary = evaluate(useStructuredFirst ? parsed : value)
  if (primary.ok && primary.value !== undefined) return primary.value
  if (parsed !== value) return evaluate(useStructuredFirst ? value : parsed).value
  return primary.value
}

export function renderResultTemplate(template: string, value: unknown, variables: Record<string, unknown> = {}): string {
  return template.replace(RESULT_TOKEN, (match, expression: string) => {
    const resolved = evaluateResultExpression(expression, value, variables)
    if (resolved === undefined) return match
    if (resolved === null) return ''
    return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved)
  })
}

function insideJsonString(source: string, offset: number): boolean {
  let quoted = false
  let escaped = false
  for (let index = 0; index < offset; index += 1) {
    const character = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') escaped = true
    else if (character === '"') quoted = !quoted
  }
  return quoted
}

export function renderResultJsonTemplate(template: string, value: unknown, variables: Record<string, unknown> = {}): string {
  return template.replace(RESULT_TOKEN, (match, expression: string, offset: number) => {
    const resolved = evaluateResultExpression(expression, value, variables)
    if (resolved === undefined) return match
    if (insideJsonString(template, offset)) {
      const text = resolved === null ? '' : typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved)
      return JSON.stringify(text).slice(1, -1)
    }
    return JSON.stringify(resolved)
  })
}

export function resultPathExpression(path: Array<string | number>): string {
  return path.reduce<string>((expression, segment) => {
    if (typeof segment === 'number') return `${expression}[${segment}]`
    return /^[A-Za-z_$][\w$]*$/.test(segment)
      ? `${expression}.${segment}`
      : `${expression}[${JSON.stringify(segment)}]`
  }, 'result')
}

export function resultTemplateToken(path: Array<string | number>): string {
  return `{{${resultPathExpression(path)}}}`
}
