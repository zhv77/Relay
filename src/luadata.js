'use strict';

// A minimal parser for the Lua table literals the Warframe wiki stores data in.

const TOKEN = new RegExp(
  [
    '(?<space>\\s+)',
    '(?<comment>--\\[(?<eq>=*)\\[[\\s\\S]*?\\]\\k<eq>\\]|--[^\\n]*)',
    '(?<long>\\[(?<leq>=*)\\[[\\s\\S]*?\\]\\k<leq>\\])',
    '(?<string>"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\')',
    '(?<number>-?(?:0[xX][0-9a-fA-F]+|\\d+\\.?\\d*(?:[eE][-+]?\\d+)?|\\.\\d+))',
    '(?<name>[A-Za-z_][A-Za-z0-9_]*)',
    '(?<symbol>[{}\\[\\],=])',
  ].join('|'),
  'y'
);

const ESCAPES = {
  n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b',
  f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n',
};

class LuaSyntaxError extends Error {}

function tokenize(text) {
  const tokens = [];
  let pos = 0;
  while (pos < text.length) {
    TOKEN.lastIndex = pos;
    const match = TOKEN.exec(text);
    if (!match) {
      throw new LuaSyntaxError(
        `cannot tokenize at offset ${pos}: ${JSON.stringify(text.slice(pos, pos + 30))}`
      );
    }
    pos = TOKEN.lastIndex;
    const groups = match.groups;
    if (groups.space !== undefined || groups.comment !== undefined) continue;
    for (const kind of ['long', 'string', 'number', 'name', 'symbol']) {
      if (groups[kind] !== undefined) {
        tokens.push([kind, groups[kind]]);
        break;
      }
    }
  }
  return tokens;
}

function unquote(literal) {
  if (literal.startsWith('[')) {
    // Long bracket string: [[...]] or [=[...]=]
    const open = literal.indexOf('[', 1) + 1;
    const close = literal.lastIndexOf(']', literal.length - 2);
    return literal.slice(open, close);
  }
  const body = literal.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === '\\' && i + 1 < body.length) {
      const next = body[i + 1];
      if (next in ESCAPES) {
        out += ESCAPES[next];
        i += 1;
        continue;
      }
      if (/\d/.test(next)) {
        let digits = '';
        while (digits.length < 3 && /\d/.test(body[i + 1] || '')) {
          digits += body[i + 1];
          i += 1;
        }
        out += String.fromCharCode(Number(digits));
        continue;
      }
      out += next;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.at = 0;
  }

  peek() {
    return this.at < this.tokens.length ? this.tokens[this.at] : null;
  }

  next() {
    const token = this.peek();
    if (!token) throw new LuaSyntaxError('unexpected end of input');
    this.at += 1;
    return token;
  }

  expect(value) {
    const [, text] = this.next();
    if (text !== value) throw new LuaSyntaxError(`expected ${value}, got ${text}`);
  }

  value() {
    const [kind, text] = this.next();
    if (kind === 'string' || kind === 'long') return unquote(text);
    if (kind === 'number') {
      return text.startsWith('0x') || text.startsWith('0X') ? parseInt(text, 16) : Number(text);
    }
    if (kind === 'name') {
      if (text === 'true') return true;
      if (text === 'false') return false;
      if (text === 'nil') return null;
      throw new LuaSyntaxError(`unexpected name ${text}`);
    }
    if (text === '{') return this.table();
    throw new LuaSyntaxError(`unexpected token ${text}`);
  }

  table() {
    const map = {};
    const array = [];
    for (;;) {
      const token = this.peek();
      if (!token) throw new LuaSyntaxError('unterminated table');
      if (token[1] === '}') {
        this.next();
        break;
      }

      // ["key"] = value
      if (token[1] === '[') {
        this.next();
        const key = this.value();
        this.expect(']');
        this.expect('=');
        map[String(key)] = this.value();
      } else if (token[0] === 'name' && this.tokens[this.at + 1]?.[1] === '=') {
        // key = value
        this.next();
        this.next();
        map[token[1]] = this.value();
      } else {
        array.push(this.value());
      }

      const separator = this.peek();
      if (separator && (separator[1] === ',' || separator[1] === ';')) this.next();
    }

    if (array.length && Object.keys(map).length) {
      map._array = array;
      return map;
    }
    return array.length || !Object.keys(map).length ? array : map;
  }
}

// Parse a wiki data module body into plain JavaScript values.
function loads(text) {
  const body = text.replace(/^\s*(local\s+\w+\s*=\s*)?/, '');
  const start = body.indexOf('return');
  const source = start >= 0 ? body.slice(start + 'return'.length) : body;
  const parser = new Parser(tokenize(source));
  return parser.value();
}

module.exports = { loads, LuaSyntaxError };
