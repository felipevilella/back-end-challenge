import { createHash } from 'node:crypto';

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJSON).join(',') + ']';
  }

  const object = value as Record<string, unknown>;

  return (
    '{' +
    Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJSON(object[key]))
      .join(',') +
    '}'
  );
}

export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex');
}
