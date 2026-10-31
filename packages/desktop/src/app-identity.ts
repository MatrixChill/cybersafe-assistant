/** Packaged metadata is an identity label, not authority or a credential. */
export function windowsAppIdentity(metadata: unknown, packaged: boolean): string {
  if (!packaged) return 'com.cybersafe.assistant.dev';
  const id = metadata && typeof metadata === 'object'
    ? (metadata as {cybersafeAppId?: unknown}).cybersafeAppId : undefined;
  return typeof id === 'string' && /^com\.cybersafe\.[a-z0-9.-]{1,96}$/.test(id)
    ? id : 'com.cybersafe.assistant';
}
