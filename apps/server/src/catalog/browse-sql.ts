import type { QueryResult, TableSummary } from '@derailed/shared';
import { exec, hexLiteral, type Session, type SqlEngine, tidyError } from './dbclient.ts';

/**
 * Tables, for Postgres, MySQL and MariaDB.
 *
 * Everything runs through the engine's own client with `--batch`-style output, which
 * is the one output mode meant to be read by a program. The human-readable table is
 * guesswork to parse the moment a value contains a space.
 */

/** Marks a real NULL, so it is not confused with an empty string. */
const NULL_MARK = '\x1e';

async function run(session: Session, sql: string): Promise<string> {
  const engine = session.engine as SqlEngine;
  const cmd =
    engine === 'postgres'
      ? [
          'psql',
          '-U',
          session.user,
          '-d',
          session.dbName,
          // CSV, not the unaligned format that looks more convenient. Unaligned prints
          // a value containing a newline as a newline, which turns one row holding a
          // paragraph into six rows of nonsense. CSV is the only psql output mode that
          // quotes, and quoting is the entire difficulty here.
          '--csv',
          '--pset=footer=off',
          // Without this, a NULL and an empty string are both an empty field, and the
          // screen has to guess which one it is looking at.
          `--pset=null=${NULL_MARK}`,
          '--command',
          sql,
        ]
      : [
          engine === 'mariadb' ? 'mariadb' : 'mysql',
          '-u',
          session.user,
          // Not `--raw`. Raw prints newlines and tabs inside values as themselves,
          // which turns one row containing a paragraph into six rows of nonsense.
          // Without it the client escapes them, which is the whole point of `--batch`.
          '--batch',
          session.dbName,
          '--execute',
          sql,
        ];

  const { code, out } = await exec(
    session.containerId,
    cmd,
    engine === 'postgres' ? [`PGPASSWORD=${session.password}`] : [`MYSQL_PWD=${session.password}`],
  );
  if (code !== 0) throw new Error(tidyError(out));
  return out;
}

/** Undoes the escaping `mysql --batch` applies to values. */
function unescapeMysql(value: string): string {
  return value.replace(/\\([0ntrbZ\\'"])/g, (_, char: string) => {
    const map: Record<string, string> = {
      '0': '\0',
      n: '\n',
      t: '\t',
      r: '\r',
      b: '\b',
      Z: '\x1a',
    };
    return map[char] ?? char;
  });
}

/**
 * RFC 4180 CSV, which is what `psql --csv` writes.
 *
 * Written out rather than pulled in, because the whole of it is: a quote starts a
 * field, two quotes inside one mean a literal quote, and a newline inside quotes is
 * part of the value rather than the end of the row. That last clause is the reason
 * this is here at all.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') {
          field += '"';
          at++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      started = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[at + 1] === '\n') at++;
      if (started || field !== '') {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = '';
      started = false;
    } else {
      field += char;
      started = true;
    }
  }
  if (started || field !== '') {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parse(
  engine: SqlEngine,
  output: string,
): { columns: string[]; rows: (string | null)[][] } {
  if (engine === 'postgres') {
    const [header, ...rest] = parseCsv(output);
    if (!header) return { columns: [], rows: [] };
    return {
      columns: header,
      rows: rest.map((line) => line.map((cell) => (cell === NULL_MARK ? null : cell))),
    };
  }

  const lines = output.split('\n').filter((line) => line.length > 0);
  if (!lines.length) return { columns: [], rows: [] };
  const [header = '', ...rest] = lines;
  return {
    columns: header.split('\t'),
    rows: rest.map((line) =>
      // `NULL` unquoted is how the client says null. A column whose value really is
      // the four characters N-U-L-L is indistinguishable here, which is a limit of
      // the client rather than a choice. It affects what is shown, never what is
      // written: only edited cells are sent back.
      line.split('\t').map((cell) => (cell === 'NULL' ? null : unescapeMysql(cell))),
    ),
  };
}

const TABLE_LIST: Record<SqlEngine, string> = {
  postgres: `SELECT table_name, (SELECT n_live_tup FROM pg_stat_user_tables s WHERE s.relname = t.table_name)
             FROM information_schema.tables t
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
             ORDER BY table_name`,
  mysql: `SELECT table_name, table_rows FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`,
  mariadb: `SELECT table_name, table_rows FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`,
};

export async function listTables(session: Session): Promise<TableSummary[]> {
  const output = await run(session, TABLE_LIST[session.engine as SqlEngine]);
  return parse(session.engine as SqlEngine, output)
    .rows.filter((row) => row[0])
    .map((row) => ({
      name: row[0] ?? '',
      // An estimate on both engines, and said to be one rather than presented as fact.
      approximateRows: Number(row[1] ?? 0) || 0,
    }));
}

/**
 * The name has to be one the database already told us about.
 *
 * Checked against the real list rather than escaped, because the only safe way to put
 * an identifier into a query is to know it is one you already know about. Anything
 * else is per-engine quoting rules and a bug waiting to happen.
 */
async function knownTable(session: Session, table: string): Promise<string> {
  const known = await listTables(session);
  if (!known.some((entry) => entry.name === table)) {
    throw new Error(`There is no table called "${table}" in this database.`);
  }
  return quoteName(session.engine as SqlEngine, table);
}

/**
 * An identifier, quoted.
 *
 * Only ever applied to names the database itself just reported, so this is not a
 * defence: it is what makes `order` and `My Table` work at all. The doubling rule is
 * the same in both dialects, only the character differs.
 */
function quoteName(engine: SqlEngine, identifier: string): string {
  return engine === 'postgres'
    ? `"${identifier.replace(/"/g, '""')}"`
    : `\`${identifier.replace(/`/g, '``')}\``;
}

/** The columns that identify a row, and each column's own type for casting on write. */
async function describe(
  session: Session,
  table: string,
): Promise<{ primaryKey: string[]; types: Record<string, string> }> {
  const engine = session.engine as SqlEngine;
  const sql =
    engine === 'postgres'
      ? // Joined on `relname` rather than cast to `regclass`. Casting parses the text
        // as an identifier, which case-folds it, so a table called `MyTable` would be
        // looked up as `mytable` and reported as not existing.
        `SELECT a.attname, format_type(a.atttypid, a.atttypmod),
                COALESCE((SELECT true FROM pg_index i
                          WHERE i.indrelid = a.attrelid AND i.indisprimary
                            AND a.attnum = ANY(i.indkey)), false)
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ${hexLiteral(engine, table)}
           AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`
      : `SELECT c.column_name, c.data_type, c.column_key = 'PRI'
         FROM information_schema.columns c
         WHERE c.table_schema = DATABASE() AND c.table_name = ${hexLiteral(engine, table)}
         ORDER BY c.ordinal_position`;

  const { rows } = parse(engine, await run(session, sql));
  const primaryKey: string[] = [];
  const types: Record<string, string> = {};
  for (const [name, type, isKey] of rows) {
    if (!name) continue;
    types[name] = type ?? 'text';
    if (isKey === 't' || isKey === '1' || isKey === 'true') primaryKey.push(name);
  }
  return { primaryKey, types };
}

/** How many rows there are. Exact, because an estimate next to a page number reads as a lie. */
async function countRows(session: Session, quoted: string): Promise<number | null> {
  try {
    const { rows } = parse(
      session.engine as SqlEngine,
      await run(session, `SELECT COUNT(*) FROM ${quoted}`),
    );
    const value = Number(rows[0]?.[0] ?? Number.NaN);
    return Number.isFinite(value) ? value : null;
  } catch {
    // A count on a very large table can time out. A page without a total is still a
    // usable page, so this is not worth failing the whole read for.
    return null;
  }
}

export async function readTable(
  session: Session,
  table: string,
  limit: number,
  offset: number,
): Promise<QueryResult> {
  const quoted = await knownTable(session, table);
  const size = Math.min(Math.max(1, limit), 500);
  const from = Math.max(0, offset);

  const { primaryKey } = await describe(session, table);

  /**
   * Ordered by the primary key, always.
   *
   * A `SELECT` with no `ORDER BY` returns rows in whatever order the engine finds
   * them, which is not stable: on Postgres an updated row physically moves to the end
   * of the table. Without this, editing a cell makes the row you just edited jump to
   * the last page, and paging through a table can show you the same row twice and
   * never show you another. Both look like the data is wrong.
   */
  const order = primaryKey.length
    ? ` ORDER BY ${primaryKey.map((column) => quoteName(session.engine as SqlEngine, column)).join(', ')}`
    : '';

  const [output, total] = await Promise.all([
    run(session, `SELECT * FROM ${quoted}${order} LIMIT ${size} OFFSET ${from}`),
    countRows(session, quoted),
  ]);

  const { columns, rows } = parse(session.engine as SqlEngine, output);
  return {
    columns,
    rows,
    truncated: rows.length >= size,
    readOnly: primaryKey.length === 0,
    primaryKey,
    readOnlyReason: primaryKey.length
      ? null
      : 'This table has no primary key, so there is no way to say which row an edit means.',
    total,
  };
}

/**
 * Whether a statement only reads.
 *
 * Deliberately an allowlist of first words rather than a search for dangerous ones: a
 * denylist is a guess about every way somebody could write `DROP`, and being wrong
 * once means losing a database. Anything not obviously a read is refused, and the
 * person can use the Terminal tab, where it is clear what they are doing.
 */
export function isReadOnly(sql: string): boolean {
  const trimmed = sql.trim().replace(/^\(+/, '');
  if (/;\s*\S/.test(trimmed.replace(/;\s*$/, ''))) return false;
  return /^(select|show|describe|desc|explain|with)\b/i.test(trimmed);
}

export async function runQuery(session: Session, sql: string): Promise<QueryResult> {
  if (!isReadOnly(sql)) {
    throw new Error(
      'This box only runs queries that read. Use the Terminal tab for anything that changes data.',
    );
  }
  const { columns, rows } = parse(session.engine as SqlEngine, await run(session, sql));
  return {
    columns,
    rows: rows.slice(0, 500),
    truncated: rows.length > 500,
    readOnly: true,
    primaryKey: [],
    readOnlyReason: "A query's results are a picture of the data, not the data itself.",
    total: null,
  };
}

/**
 * Changes one cell.
 *
 * One cell rather than a whole row on purpose. A row editor sends back every column,
 * including the ones nobody touched, which quietly rewrites a timestamp somebody's
 * application maintains. This writes what was changed and nothing else.
 *
 * Nothing is escaped anywhere in here. Identifiers are checked against the catalogue,
 * values become hex, and the cast comes from the column's own declared type.
 */
export async function updateCell(
  session: Session,
  table: string,
  key: Record<string, string | null>,
  column: string,
  value: string | null,
): Promise<void> {
  const engine = session.engine as SqlEngine;
  const quoted = await knownTable(session, table);
  const { primaryKey, types } = await describe(session, table);

  if (primaryKey.length === 0) {
    throw new Error(
      'This table has no primary key, so there is no way to say which row to change.',
    );
  }
  if (!(column in types)) throw new Error(`There is no column called "${column}".`);
  if (primaryKey.some((name) => key[name] === undefined || key[name] === null)) {
    throw new Error('That row could not be identified.');
  }

  const name = (identifier: string) => quoteName(engine, identifier);
  const literal = (raw: string | null, column: string) =>
    raw === null
      ? 'NULL'
      : hexLiteral(engine, raw, engine === 'postgres' ? types[column] : undefined);

  const where = primaryKey
    .map((pk) => `${name(pk)} = ${literal(key[pk] ?? null, pk)}`)
    .join(' AND ');

  const output = await run(
    session,
    `UPDATE ${quoted} SET ${name(column)} = ${literal(value, column)} WHERE ${where}`,
  );
  // Postgres prints `UPDATE 0` when nothing matched, which happens when somebody edits
  // a row that has since been deleted. Silence there would look like it worked.
  if (/^UPDATE 0\s*$/m.test(output)) {
    throw new Error('That row is no longer there. Reload the table.');
  }
}
