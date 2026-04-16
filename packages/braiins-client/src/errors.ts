/**
 * Custom error types for the Braiins Hashpower API client.
 *
 * Braiins reports API-level error reasons in the response header
 * `grpc-message` (URL-encoded UTF-8). See RESEARCH.md §2.
 */

export class BraiinsApiError extends Error {
  public readonly status: number;
  public readonly grpcMessage: string | undefined;
  public readonly endpoint: string;
  public readonly body: unknown;

  constructor(args: {
    status: number;
    endpoint: string;
    grpcMessage?: string | undefined;
    body?: unknown;
    message?: string;
  }) {
    const grpcPart = args.grpcMessage ? ` — ${args.grpcMessage}` : '';
    super(args.message ?? `Braiins API ${args.endpoint} returned ${args.status}${grpcPart}`);
    this.name = 'BraiinsApiError';
    this.status = args.status;
    this.endpoint = args.endpoint;
    this.grpcMessage = args.grpcMessage;
    this.body = args.body;
  }
}

/**
 * Extract and decode the `grpc-message` header. Braiins percent-encodes it
 * (UTF-8 → percent-escapes) so we decodeURIComponent. Header name lookup
 * is case-insensitive per RFC 7230.
 */
export function readGrpcMessage(headers: Headers): string | undefined {
  const raw = headers.get('grpc-message');
  if (raw === null) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding: return the raw value rather than throwing,
    // so callers still see something useful in logs.
    return raw;
  }
}

export class BraiinsAuthMissingError extends Error {
  public readonly role: 'READ_ONLY' | 'OWNER';

  constructor(role: 'READ_ONLY' | 'OWNER') {
    super(`Braiins API call requires a ${role} token but none was configured`);
    this.name = 'BraiinsAuthMissingError';
    this.role = role;
  }
}

export class BraiinsNetworkError extends Error {
  public readonly endpoint: string;

  constructor(endpoint: string, cause: unknown) {
    super(`Braiins API network error on ${endpoint}: ${String(cause)}`, { cause });
    this.name = 'BraiinsNetworkError';
    this.endpoint = endpoint;
  }
}
