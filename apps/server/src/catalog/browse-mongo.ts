import type { QueryResult, TableSummary } from '@derailed/shared';
import { exec, type Session, tidyError } from './dbclient.ts';

/**
 * Collections, for MongoDB.
 *
 * Documents do not have columns, so a table of them is a lie told carefully: the
 * columns are the union of the top-level field names on the page you are looking at,
 * in the order they first appear, and a document without one shows a blank rather
 * than an empty string. It reads like the data, which is the point, and the full
 * document is one click away for the parts that do not fit a grid.
 */

/**
 * `mongosh` takes its connection string on the command line, and an argument list is
 * readable by every process in the container. So the URI goes in the environment and
 * the script goes in as a positional parameter, which means the shell never parses
 * either of them: `$0` is expanded by the shell, not re-lexed.
 */
async function run(session: Session, script: string, timeoutMs = 30_000): Promise<string> {
  const uri = `mongodb://${encodeURIComponent(session.user)}:${encodeURIComponent(session.password)}@127.0.0.1:27017/${encodeURIComponent(session.dbName)}?authSource=admin`;
  const { code, out } = await exec(
    session.containerId,
    ['/bin/sh', '-c', 'exec mongosh "$MONGO_URI" --quiet --eval "$0"', script],
    [`MONGO_URI=${uri}`],
    timeoutMs,
  );
  if (code !== 0) throw new Error(tidyError(out));
  return out;
}

/** A JS string literal, produced by the JSON encoder rather than by hand. */
const js = (value: string) => JSON.stringify(value);

export async function listCollections(session: Session): Promise<TableSummary[]> {
  const output = await run(
    session,
    'db.getCollectionNames().forEach(function (n) { print(n + "\\t" + db.getCollection(n).estimatedDocumentCount()); });',
  );
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', count = '0'] = line.split('\t');
      return { name, approximateRows: Number(count) || 0 };
    })
    .filter((entry) => entry.name);
}

async function knownCollection(session: Session, name: string): Promise<void> {
  const known = await listCollections(session);
  if (!known.some((entry) => entry.name === name)) {
    throw new Error(`There is no collection called "${name}" in this database.`);
  }
}

/**
 * Documents, flattened into a grid.
 *
 * Nested objects and arrays are shown as their JSON rather than expanded into more
 * columns. A document five levels deep would otherwise produce a table hundreds of
 * columns wide, most of them empty, which is less readable than the JSON was.
 */
function toGrid(lines: string[]): { columns: string[]; rows: (string | null)[][] } {
  const documents = lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  const columns: string[] = [];
  for (const document of documents) {
    for (const key of Object.keys(document)) if (!columns.includes(key)) columns.push(key);
  }

  const rows = documents.map((document) =>
    columns.map((column) => {
      if (!(column in document)) return null;
      const value = document[column];
      if (value === null) return null;
      if (typeof value === 'object') {
        // `{"$oid": "..."}` is how extended JSON writes an ObjectId, and the id is
        // the only part anybody wants to read.
        const single = value as Record<string, unknown>;
        const keys = Object.keys(single);
        if (keys.length === 1 && keys[0]?.startsWith('$')) return String(single[keys[0]]);
        return JSON.stringify(value);
      }
      return String(value);
    }),
  );

  return { columns, rows };
}

export async function readCollection(
  session: Session,
  name: string,
  limit: number,
  offset: number,
): Promise<QueryResult> {
  await knownCollection(session, name);
  const size = Math.min(Math.max(1, limit), 500);
  const from = Math.max(0, offset);

  const output = await run(
    session,
    `var c = db.getCollection(${js(name)});
     print("\\u001ecount\\u001e" + c.estimatedDocumentCount());
     c.find({}).skip(${from}).limit(${size}).forEach(function (d) { print(EJSON.stringify(d)); });`,
  );

  const lines = output.split('\n').filter(Boolean);
  const countLine = lines.find((line) => line.startsWith('\x1ecount\x1e'));
  const total = countLine ? Number(countLine.slice(7)) : null;
  const { columns, rows } = toGrid(lines.filter((line) => !line.startsWith('\x1ecount\x1e')));

  return {
    columns,
    rows,
    truncated: rows.length >= size,
    // Documents are edited whole, on their own screen, not cell by cell in the grid.
    // A field in one document is not the same field in the next.
    readOnly: true,
    primaryKey: ['_id'],
    readOnlyReason: 'Documents are edited one at a time, as JSON. Open one to change it.',
    total: Number.isFinite(total) ? total : null,
  };
}

/** One document, as the JSON somebody would edit. */
export async function readDocument(session: Session, name: string, id: string): Promise<string> {
  await knownCollection(session, name);
  const output = await run(
    session,
    `var d = db.getCollection(${js(name)}).findOne({ _id: { $in: idCandidates(${js(id)}) } });
     if (!d) { print("\\u001enone"); } else { print(EJSON.stringify(d, null, 2)); }
     function idCandidates(v) { var out = [v]; try { out.push(new ObjectId(v)); } catch (e) {} if (v !== "" && !isNaN(Number(v))) out.push(Number(v)); return out; }`,
  );
  if (output.includes('\x1enone')) throw new Error('That document is no longer there.');
  return output.trim();
}

/**
 * Replaces a document, keeping its `_id`.
 *
 * `replaceOne` rather than `updateOne` with `$set`, because what was edited was the
 * whole document: a field deleted in the editor has to actually go, and `$set` would
 * quietly leave it.
 */
export async function replaceDocument(
  session: Session,
  name: string,
  id: string,
  json: string,
): Promise<void> {
  await knownCollection(session, name);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That is not valid JSON, so it has not been saved.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('A document has to be a JSON object.');
  }

  const output = await run(
    session,
    `var id = { $in: idCandidates(${js(id)}) };
     var doc = EJSON.parse(${js(json)});
     delete doc._id;
     var r = db.getCollection(${js(name)}).replaceOne({ _id: id }, doc);
     print("\\u001ematched\\u001e" + r.matchedCount);
     function idCandidates(v) { var out = [v]; try { out.push(new ObjectId(v)); } catch (e) {} if (v !== "" && !isNaN(Number(v))) out.push(Number(v)); return out; }`,
  );
  if (output.includes('\x1ematched\x1e0')) {
    throw new Error('That document is no longer there. Reload the collection.');
  }
}

export async function deleteDocument(session: Session, name: string, id: string): Promise<void> {
  await knownCollection(session, name);
  await run(
    session,
    `db.getCollection(${js(name)}).deleteOne({ _id: { $in: idCandidates(${js(id)}) } });
     function idCandidates(v) { var out = [v]; try { out.push(new ObjectId(v)); } catch (e) {} if (v !== "" && !isNaN(Number(v))) out.push(Number(v)); return out; }`,
  );
}

/**
 * Whether an expression only reads.
 *
 * The same allowlist reasoning as the SQL box: this is a `mongosh` session, so an
 * expression can do anything at all, and guessing at the dangerous ones is a way to
 * be wrong once and lose a collection. Only the reading methods are allowed, and the
 * expression has to start at `db.`.
 */
const READING_METHODS =
  /\.(find|findOne|aggregate|countDocuments|estimatedDocumentCount|distinct|getIndexes|explain|stats)\s*\(/;
const WRITING_METHODS =
  /\.(insert|insertOne|insertMany|update|updateOne|updateMany|replaceOne|delete|deleteOne|deleteMany|remove|drop|dropDatabase|createIndex|renameCollection|bulkWrite|save|createCollection|runCommand|eval|adminCommand|mapReduce)\s*\(/;

/**
 * The writes that hide inside a reading method, and the JavaScript that hides inside a
 * query object.
 *
 * `aggregate` is a reading method, but an `$out` or `$merge` stage at the end of its
 * pipeline lands the result in a collection, a write wearing a read's name. `mapReduce`
 * can do the same through its `out` option. And `$where`, `$function` and `$accumulator`
 * are server-side JavaScript: an expression that runs whatever it likes on the database
 * host, which is not something a box that promises it only reads should hand through.
 */
const DANGEROUS_MONGO = /\$out\b|\$merge\b|\$where\b|\$function\b|\$accumulator\b/i;

/**
 * A method reached by a string key rather than a dot.
 *
 * `db.orders["drop"]()` runs the same drop as `db.orders.drop()`, but the writing-method
 * list only knows the `.drop(` shape and never sees it. A reading query names things with
 * dots and uses brackets only for array literals and numeric indexes, so a bracket with a
 * quoted key right after a value (`x["drop"]`, `find()['forEach']`, `db['users']`) is
 * the computed-access dodge, not an honest query. Refuse it.
 */
const COMPUTED_ACCESS = /[\w)\]]\s*\[\s*['"`]/;

export function isReadOnlyMongo(expression: string): boolean {
  const trimmed = expression.trim().replace(/;+\s*$/, '');
  if (trimmed.includes(';')) return false;
  if (!/^db\b/.test(trimmed)) return false;
  if (WRITING_METHODS.test(trimmed)) return false;
  if (DANGEROUS_MONGO.test(trimmed)) return false;
  if (COMPUTED_ACCESS.test(trimmed)) return false;
  return READING_METHODS.test(trimmed);
}

export async function runMongoQuery(session: Session, expression: string): Promise<QueryResult> {
  if (!isReadOnlyMongo(expression)) {
    throw new Error(
      'This box only runs expressions that read, like db.users.find({ active: true }). Use the Terminal tab for anything that changes data.',
    );
  }

  const output = await run(
    session,
    `var r = (${expression});
     if (r && typeof r.forEach === "function" && typeof r.hasNext === "function") {
       r.forEach(function (d) { print(EJSON.stringify(d)); });
     } else if (Array.isArray(r)) {
       r.forEach(function (d) { print(EJSON.stringify(d)); });
     } else if (r && typeof r === "object") {
       print(EJSON.stringify(r));
     } else {
       print(EJSON.stringify({ result: r }));
     }`,
  );

  const { columns, rows } = toGrid(output.split('\n').filter(Boolean));
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
