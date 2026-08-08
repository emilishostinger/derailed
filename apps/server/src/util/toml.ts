/**
 * The slice of TOML a fly.toml actually uses: tables, arrays of tables, and
 * plain key = value pairs holding strings, numbers, booleans and flat arrays.
 *
 * Hand-rolled for the same reason every parser here is: the alternative is a
 * dependency shipped to every server for one file read once at import time.
 * Anything outside the slice (dates, dotted keys, multi-line strings, nested
 * inline tables) is not something a fly.toml contains, and a file that somehow
 * does simply loses those keys rather than gaining wrong ones.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

function parseScalar(raw: string): TomlValue {
  const text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^[+-]?\d+$/.test(text)) return Number(text);
  if (/^[+-]?\d*\.\d+$/.test(text)) return Number(text);
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map(parseScalar);
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const table: TomlTable = {};
    const inner = text.slice(1, -1).trim();
    if (!inner) return table;
    for (const part of splitTopLevel(inner)) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      table[unquoteKey(part.slice(0, eq).trim())] = parseScalar(part.slice(eq + 1));
    }
    return table;
  }
  // Bare words (dates, mistakes) come through as their text.
  return text;
}

/** Splits `a, b, [c, d], "e,f"` on the commas that are actually separators. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      current += char;
      if (char === inString && text[i - 1] !== '\\') inString = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      current += char;
    } else if (char === '[' || char === '{') {
      depth++;
      current += char;
    } else if (char === ']' || char === '}') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function unquoteKey(key: string): string {
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    return key.slice(1, -1);
  }
  return key;
}

/** A line's content with any comment removed, respecting strings. */
function stripComment(line: string): string {
  let inString: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inString) {
      if (char === inString && line[i - 1] !== '\\') inString = null;
      continue;
    }
    if (char === '"' || char === "'") inString = char;
    else if (char === '#') return line.slice(0, i);
  }
  return line;
}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;

  const enter = (path: string, asArrayItem: boolean): void => {
    const keys = path.split('.').map((key) => unquoteKey(key.trim()));
    let cursor: TomlTable = root;
    for (const [index, key] of keys.entries()) {
      const last = index === keys.length - 1;
      if (last && asArrayItem) {
        if (cursor[key] === undefined) cursor[key] = [];
        const list = cursor[key];
        if (!Array.isArray(list)) return;
        const item: TomlTable = {};
        list.push(item);
        cursor = item;
      } else {
        const existing = cursor[key];
        if (Array.isArray(existing)) {
          // Descending into [[services]] then [services.concurrency] means the
          // newest item of the array.
          const lastItem = existing[existing.length - 1];
          if (lastItem && typeof lastItem === 'object' && !Array.isArray(lastItem)) {
            cursor = lastItem as TomlTable;
          } else {
            return;
          }
        } else if (existing && typeof existing === 'object') {
          cursor = existing as TomlTable;
        } else {
          const table: TomlTable = {};
          cursor[key] = table;
          cursor = table;
        }
      }
    }
    current = cursor;
  };

  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const arrayHeader = /^\[\[(.+)\]\]$/.exec(line);
    if (arrayHeader) {
      enter(arrayHeader[1]!, true);
      continue;
    }
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      enter(header[1]!, false);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = unquoteKey(line.slice(0, eq).trim());
    if (!key) continue;
    current[key] = parseScalar(line.slice(eq + 1));
  }

  return root;
}
