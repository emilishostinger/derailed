import type { SystemInfo, User } from '@derailed/shared';

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'x-requested-with': 'derailed',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'offline',
      "Can't reach your server.",
      'Check that Derailed is still running, then reload this page.',
    );
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as { error?: { code: string; message: string; hint?: string } })?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'server_error',
      error?.message ?? 'Something went wrong.',
      error?.hint,
    );
  }
  return payload as T;
}

/**
 * Multipart, for file uploads. Kept separate because `request` always JSON-encodes,
 * and setting content-type by hand on a FormData body breaks the boundary header.
 */
async function upload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-requested-with': 'derailed' },
    body: form,
  }).catch(() => null);

  if (!response) {
    throw new ApiError(0, 'offline', "Can't reach your server.", 'Check that Derailed is running.');
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as { error?: { code: string; message: string; hint?: string } })?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'server_error',
      error?.message ?? 'That upload failed.',
      error?.hint,
    );
  }
  return payload as T;
}

export const api = {
  upload,
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  delete: <T>(path: string) => request<T>('DELETE', path),

  me: () => request<{ user: User }>('GET', '/auth/me'),
  authStatus: () => request<{ setupComplete: boolean }>('GET', '/auth/status'),
  setup: (email: string, password: string) =>
    request<{ user: User }>('POST', '/auth/setup', { email, password }),
  login: (email: string, password: string) =>
    request<{ user: User }>('POST', '/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout', {}),
  system: () => request<{ system: SystemInfo }>('GET', '/system'),
  patchSystem: (serverIp: string | null) =>
    request<{ system: SystemInfo }>('PATCH', '/system', { serverIp }),
};
