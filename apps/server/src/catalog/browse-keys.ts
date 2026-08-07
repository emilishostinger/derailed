import type { KeyPage, KeyValue, QueryResult } from '@derailed/shared';
import { exec, type Session, tidyError } from './dbclient.ts';

/**
 * Keys, for Redis and Valkey.
 *
 * These are the two engines a hosting panel usually gives up on, and they are also
 * the ones where "is my data actually in there?" is asked most often, because a cache
 * that is not working looks exactly like a cache that is working.
 *
 * `SCAN` rather than `KEYS`, always. `KEYS *` on a production instance blocks the
 * server for as long as it takes to walk every key, which is a way to take somebody's
 * site down from a page whose whole purpose is looking.
 */

/**
 * The client reads its password from `REDISCLI_AUTH`, so it never appears in an
 * argument list where every process in the container could read it. `valkey-cli` is
 * a fork of `redis-cli` and honours the same variable.
 */
async function run(session: Session, args: string[], timeoutMs = 30_000): Promise<string> {
  const client = session.engine === 'valkey' ? 'valkey-cli' : 'redis-cli';
  const { code, out } = await exec(
    session.containerId,
    [client, '--raw', ...args],
    [`REDISCLI_AUTH=${session.password}`],
    timeoutMs,
  );
  if (code !== 0) throw new Error(tidyError(out));
  if (/^(ERR|WRONGTYPE|NOAUTH|NOPERM)\b/m.test(out)) throw new Error(tidyError(out));
  return out;
}

/**
 * One page of keys, with each key's type and expiry.
 *
 * Done in Lua so it is one round trip instead of one per key. A thousand keys through
 * three commands each is three thousand exec calls into a container, which is slower
 * than the database it is asking about by several orders of magnitude.
 */
const SCAN_SCRIPT = `
local res = redis.call("scan", ARGV[1], "match", ARGV[2], "count", ARGV[3])
local out = { res[1] }
for _, k in ipairs(res[2]) do
  out[#out + 1] = k
  out[#out + 1] = redis.call("type", k)["ok"]
  out[#out + 1] = tostring(redis.call("ttl", k))
end
return out`;

export async function scanKeys(
  session: Session,
  pattern: string,
  cursor: string,
  count = 100,
): Promise<KeyPage> {
  const safeCursor = /^\d+$/.test(cursor) ? cursor : '0';
  const safeCount = String(Math.min(Math.max(10, count), 500));
  const output = await run(session, [
    'eval',
    SCAN_SCRIPT,
    '0',
    safeCursor,
    pattern || '*',
    safeCount,
  ]);

  const lines = output.split('\n');
  const next = (lines.shift() ?? '0').trim();
  const keys: KeyPage['keys'] = [];
  for (let at = 0; at + 2 < lines.length + 1; at += 3) {
    const name = lines[at];
    if (name === undefined || name === '') continue;
    const ttl = Number(lines[at + 2] ?? '-1');
    keys.push({
      name,
      type: lines[at + 1] ?? 'unknown',
      expiresIn: ttl >= 0 ? ttl : null,
    });
  }

  // A zero cursor means the walk is finished. It does not mean the page is full: SCAN
  // is allowed to return nothing at all and still have more to come, which is why the
  // cursor rather than the count decides.
  return { keys, cursor: next === '0' ? null : next };
}

/** Everything about one key, in one round trip, whatever type it turns out to be. */
const VALUE_SCRIPT = `
local k = KEYS[1]
local t = redis.call("type", k)["ok"]
local limit = tonumber(ARGV[1])
local out = { t, tostring(redis.call("ttl", k)) }
if t == "string" then
  out[#out + 1] = redis.call("get", k)
elseif t == "list" then
  for _, v in ipairs(redis.call("lrange", k, 0, limit - 1)) do out[#out + 1] = v end
elseif t == "hash" then
  for _, v in ipairs(redis.call("hscan", k, 0, "count", limit)[2]) do out[#out + 1] = v end
elseif t == "set" then
  for _, v in ipairs(redis.call("sscan", k, 0, "count", limit)[2]) do out[#out + 1] = v end
elseif t == "zset" then
  for _, v in ipairs(redis.call("zrange", k, 0, limit - 1, "withscores")) do out[#out + 1] = v end
end
return out`;

const PAIRED = new Set(['hash', 'zset']);

export async function readKey(session: Session, key: string, limit = 200): Promise<KeyValue> {
  const output = await run(session, [
    'eval',
    VALUE_SCRIPT,
    '1',
    key,
    String(Math.min(Math.max(10, limit), 1000)),
  ]);

  const lines = output.split('\n');
  const type = (lines.shift() ?? 'none').trim();
  const ttl = Number((lines.shift() ?? '-1').trim());
  if (type === 'none') throw new Error('There is no key by that name.');

  // The client separates values with newlines and ends with one, so the trailing
  // empty line is punctuation rather than a value.
  if (lines[lines.length - 1] === '') lines.pop();

  const entries: KeyValue['entries'] = [];
  if (type === 'string') {
    // Joined rather than split. Half of everything in a cache is JSON, and JSON is
    // full of newlines: treating each line as its own value would show a fragment
    // and then save the fragment back over the whole thing.
    entries.push({ field: null, value: lines.join('\n') });
  } else if (PAIRED.has(type)) {
    for (let at = 0; at + 1 < lines.length; at += 2) {
      entries.push({ field: lines[at] ?? '', value: lines[at + 1] ?? '' });
    }
  } else {
    for (const value of lines) entries.push({ field: null, value });
  }

  return {
    key,
    type,
    expiresIn: ttl >= 0 ? ttl : null,
    entries,
    truncated: entries.length >= limit,
    // Only a plain string. Editing one member of a sorted set through a text box is a
    // way to lose its score, and a list has an order that a grid cannot express.
    editable: type === 'string',
  };
}

/** Changes a string key, keeping whatever expiry it already had. */
export async function setKey(session: Session, key: string, value: string): Promise<void> {
  const existing = await readKey(session, key, 10);
  if (existing.type !== 'string') {
    throw new Error(`That key holds a ${existing.type}, which cannot be edited as text here.`);
  }
  await run(
    session,
    existing.expiresIn === null ? ['set', key, value] : ['set', key, value, 'KEEPTTL'],
  );
}

export async function deleteKey(session: Session, key: string): Promise<void> {
  await run(session, ['del', key]);
}

/**
 * The commands the query box will run.
 *
 * An allowlist, for the same reason as everywhere else here: naming the dangerous
 * ones means being wrong about `FLUSHALL` exactly once. `KEYS` is deliberately absent
 * even though it only reads, because running it against a large instance is how you
 * take a site down without meaning to. The key browser above uses `SCAN`, which is
 * what `KEYS` should have been.
 */
const READING_COMMANDS = new Set([
  'get',
  'mget',
  'strlen',
  'getrange',
  'exists',
  'type',
  'ttl',
  'pttl',
  'randomkey',
  'dbsize',
  'scan',
  'hget',
  'hmget',
  'hgetall',
  'hkeys',
  'hvals',
  'hlen',
  'hexists',
  'hscan',
  'lrange',
  'llen',
  'lindex',
  'smembers',
  'scard',
  'sismember',
  'sscan',
  'srandmember',
  'zrange',
  'zrevrange',
  'zrangebyscore',
  'zcard',
  'zscore',
  'zrank',
  'zscan',
  'xrange',
  'xlen',
  'info',
  'memory',
  'object',
  'lolwut',
]);

/** Splits a typed command the way a shell would, so quoted arguments hold together. */
export function splitCommand(input: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = pattern.exec(input);
  while (match) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? '');
    match = pattern.exec(input);
  }
  return parts;
}

export function isReadOnlyCommand(input: string): boolean {
  const [command] = splitCommand(input);
  return command !== undefined && READING_COMMANDS.has(command.toLowerCase());
}

export async function runKeyCommand(session: Session, input: string): Promise<QueryResult> {
  const parts = splitCommand(input);
  if (!isReadOnlyCommand(input)) {
    throw new Error(
      `This box only runs commands that read, like GET, HGETALL or SCAN. Use the Terminal tab for anything that changes data.`,
    );
  }

  const output = await run(session, parts);
  const lines = output.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  return {
    columns: ['reply'],
    rows: lines.slice(0, 500).map((line) => [line]),
    truncated: lines.length > 500,
    readOnly: true,
    primaryKey: [],
    readOnlyReason: "A command's reply is a picture of the data, not the data itself.",
    total: null,
  };
}
