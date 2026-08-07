import type { KeyPage, KeyValue, QueryResult, TableSummary } from '@derailed/shared';
import { deleteKey, readKey, runKeyCommand, scanKeys, setKey } from './browse-keys.ts';
import {
  deleteDocument,
  listCollections,
  readCollection,
  readDocument,
  replaceDocument,
  runMongoQuery,
} from './browse-mongo.ts';
import {
  listTables as listSqlTables,
  readTable as readSqlTable,
  runQuery as runSqlQuery,
  updateCell as updateSqlCell,
} from './browse-sql.ts';
import { browseKind, openSession } from './dbclient.ts';

/**
 * Looking inside a database, whichever one it is.
 *
 * Databases are one click to create and then a black box for ever, which leaves "is
 * my data actually in there?" answerable only by installing a client and remembering
 * a connection string. That is the last real reason to SSH into the machine.
 *
 * Three of the six engines keep rows, one keeps documents and two keep keys, so this
 * is one screen rather than one feature: the questions are the same, and the answers
 * arrive in the same shape. Everything runs the engine's own client inside the
 * engine's own container, so there is no driver bundled here, no port opened and
 * nothing new listening anywhere.
 */

export { isReadOnlyCommand, splitCommand } from './browse-keys.ts';
export { isReadOnlyMongo } from './browse-mongo.ts';
export { isReadOnly } from './browse-sql.ts';
export { browseKind, canBrowse } from './dbclient.ts';

/** Tables, collections, or nothing at all when the answer is a key space. */
export async function listTables(serviceId: string): Promise<TableSummary[]> {
  const session = await openSession(serviceId);
  switch (browseKind(session.engine)) {
    case 'sql':
      return listSqlTables(session);
    case 'documents':
      return listCollections(session);
    default:
      // Keys have no tables. The screen shows a key browser instead, so an empty list
      // here is the honest answer rather than a failure.
      return [];
  }
}

export async function readTable(
  serviceId: string,
  table: string,
  limit = 100,
  offset = 0,
): Promise<QueryResult> {
  const session = await openSession(serviceId);
  switch (browseKind(session.engine)) {
    case 'sql':
      return readSqlTable(session, table, limit, offset);
    case 'documents':
      return readCollection(session, table, limit, offset);
    default:
      throw new Error('This database keeps keys rather than tables.');
  }
}

export async function runQuery(serviceId: string, body: string): Promise<QueryResult> {
  const session = await openSession(serviceId);
  switch (browseKind(session.engine)) {
    case 'sql':
      return runSqlQuery(session, body);
    case 'documents':
      return runMongoQuery(session, body);
    default:
      return runKeyCommand(session, body);
  }
}

/** Changes one cell of one row. Only tables have these. */
export async function updateCell(
  serviceId: string,
  table: string,
  key: Record<string, string | null>,
  column: string,
  value: string | null,
): Promise<void> {
  const session = await openSession(serviceId);
  if (browseKind(session.engine) !== 'sql') {
    throw new Error('Only a table has cells to change.');
  }
  await updateSqlCell(session, table, key, column, value);
}

export async function getDocument(
  serviceId: string,
  collection: string,
  id: string,
): Promise<string> {
  const session = await openSession(serviceId);
  if (browseKind(session.engine) !== 'documents') throw new Error('That is not a document store.');
  return readDocument(session, collection, id);
}

export async function putDocument(
  serviceId: string,
  collection: string,
  id: string,
  json: string,
): Promise<void> {
  const session = await openSession(serviceId);
  if (browseKind(session.engine) !== 'documents') throw new Error('That is not a document store.');
  await replaceDocument(session, collection, id, json);
}

export async function removeDocument(
  serviceId: string,
  collection: string,
  id: string,
): Promise<void> {
  const session = await openSession(serviceId);
  if (browseKind(session.engine) !== 'documents') throw new Error('That is not a document store.');
  await deleteDocument(session, collection, id);
}

export async function browseKeys(
  serviceId: string,
  pattern: string,
  cursor: string,
): Promise<KeyPage> {
  const session = await openSession(serviceId);
  if (browseKind(session.engine) !== 'keys')
    throw new Error('This database keeps tables, not keys.');
  return scanKeys(session, pattern, cursor);
}

export async function getKey(serviceId: string, key: string): Promise<KeyValue> {
  const session = await openSession(serviceId);
  if (browseKind(session.engine) !== 'keys')
    throw new Error('This database keeps tables, not keys.');
  return readKey(session, key);
}

export async function putKey(serviceId: string, key: string, value: string): Promise<void> {
  const session = await openSession(serviceId);
  if (browseKind(session.engine) !== 'keys')
    throw new Error('This database keeps tables, not keys.');
  await setKey(session, key, value);
}

export async function removeKey(serviceId: string, key: string): Promise<void> {
  const session = await openSession(serviceId);
  if (browseKind(session.engine) !== 'keys')
    throw new Error('This database keeps tables, not keys.');
  await deleteKey(session, key);
}
