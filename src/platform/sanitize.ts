export function sanitizePayload<T>(payload: T): T {
  const cloned = structuredClone(payload);
  return harden(cloned);
}
