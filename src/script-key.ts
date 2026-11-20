import { createHash } from 'node:crypto';

/**
 * Identity of a script across runs: origin and path, without query string or fragment.
 * Cache busters (`?v=123`) and per-request parameters would otherwise make every load
 * look like a different script.
 */
export function scriptKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Short stable id for file names and URLs of the status site. */
export function shortId(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}
