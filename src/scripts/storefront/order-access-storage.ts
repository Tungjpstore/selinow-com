export type OrderAccessStorageLike = {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
};

export type OrderAccessStorage = {
  get(key: string): string | null;
  remove(key: string): void;
  set(key: string, value: string): void;
};

/** Keep the current tab usable when privacy mode or quota blocks Web Storage. */
export function createOrderAccessStorage(storage: OrderAccessStorageLike | null | undefined): OrderAccessStorage {
  const fallback = new Map<string, string>();

  return {
    get(key) {
      const fallbackValue = fallback.get(key);
      if (fallbackValue !== undefined) return fallbackValue;
      try {
        const value = storage?.getItem(key) ?? null;
        if (value !== null) return value;
      } catch {
        // Continue with the in-memory token for this tab.
      }
      return fallback.get(key) ?? null;
    },
    remove(key) {
      fallback.delete(key);
      try {
        storage?.removeItem(key);
      } catch {
        // Storage is optional; removing the fallback still revokes this tab's copy.
      }
    },
    set(key, value) {
      if (storage === null || storage === undefined) {
        fallback.set(key, value);
        return;
      }
      try {
        storage.setItem(key, value);
        fallback.delete(key);
        return;
      } catch {
        // Preserve access in memory when persistent storage is unavailable.
      }
      fallback.set(key, value);
    },
  };
}

export function createBrowserOrderAccessStorage(): OrderAccessStorage {
  const storage: OrderAccessStorageLike | null = (() => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  })();
  return createOrderAccessStorage(storage);
}
