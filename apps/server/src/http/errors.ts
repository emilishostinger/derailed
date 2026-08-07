import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { FriendlyError } from '../build/git.ts';

/**
 * Every error that reaches the user carries a human-readable message and, where we
 * can, a hint that says what to do next. Codes are for the client, messages are for people.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, hint?: string) =>
  new ApiError(400, 'bad_request', message, hint);

export const unauthorized = (message = 'Please sign in to continue.') =>
  new ApiError(401, 'unauthorized', message);

export const forbidden = (message: string, hint?: string) =>
  new ApiError(403, 'forbidden', message, hint);

export const notFound = (what = 'That') => new ApiError(404, 'not_found', `${what} doesn't exist.`);

export const conflict = (message: string, hint?: string) =>
  new ApiError(409, 'conflict', message, hint);

export const tooManyRequests = (message: string, hint?: string) =>
  new ApiError(429, 'too_many_requests', message, hint);

export const serverError = (message: string, hint?: string) =>
  new ApiError(500, 'server_error', message, hint);

export function errorResponse(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json(
      { error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) } },
      err.status as 400,
    );
  }

  // FriendlyError is what the build pipeline, the git layer and the database catalog
  // throw. It already carries exactly what the user needs to read, so passing it
  // through as a generic 500 threw away the entire point of writing those messages.
  if (err instanceof FriendlyError) {
    return c.json(
      {
        error: {
          code: 'bad_request',
          message: err.message,
          ...(err.hint ? { hint: err.hint } : {}),
          ...(err.detail?.length ? { detail: err.detail } : {}),
        },
      },
      400,
    );
  }

  console.error('[derailed] unhandled error:', err);
  return c.json(
    {
      error: {
        code: 'server_error',
        message: 'Something went wrong on the server.',
        hint: 'Check the Derailed logs with: journalctl -u derailed -n 100',
      },
    },
    500,
  );
}

/**
 * Checks an already-read value against a schema, as a 400 rather than a throw.
 *
 * Separate from `parseBody` for the handful of routes that have to read the body
 * themselves, because they accept a field the schema does not describe. Those routes
 * were reaching for zod's `parse`, which throws a `ZodError` that nothing here knows
 * how to answer, so a body of the wrong shape came back as "Something went wrong on
 * the server". On the sign-in route, which is the one endpoint on the machine that
 * strangers are meant to reach, every malformed request was a 500.
 */
export function parseValue<T>(schema: ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.');
    throw badRequest(first?.message ?? 'Some of those values are not valid.', path || undefined);
  }
  return result.data;
}

/** Parses a JSON body against a zod schema, surfacing the first message as-is. */
export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('That request was not valid JSON.');
  }
  return parseValue(schema, raw);
}
