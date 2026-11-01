/** Every key we write starts with this prefix; ?reset=1 removes only those. */
export const STORAGE_PREFIX = 'indoorweather.';

export function resetProgress(storage: Storage | undefined = globalThis.localStorage): number {
  if (!storage) return 0;
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Private mode or blocked storage: nothing to reset.
    return 0;
  }
  return keys.length;
}
