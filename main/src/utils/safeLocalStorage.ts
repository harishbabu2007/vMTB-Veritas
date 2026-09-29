// window.localStorage can throw on access, not just on read/write, under
// Safari's "Block All Cookies" setting or some restrictive private-browsing /
// embedded contexts (an all-WebKit storage-policy behavior, not Safari-UI-only).
// Supabase's auth client reads/writes its storage option eagerly at module
// load, so an unguarded window.localStorage reference there can crash the
// whole app before anything renders. This falls back to an in-memory store:
// the session then just doesn't survive a reload, instead of the app failing
// to load at all.
function createMemoryStore() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

function localStorageIsUsable(): boolean {
  try {
    const probeKey = '__vmtb_storage_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

export const safeLocalStorage = localStorageIsUsable()
  ? {
      getItem: (key: string) => {
        try {
          return window.localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      setItem: (key: string, value: string) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          // Ignore — e.g. private-browsing quota. Session just won't persist.
        }
      },
      removeItem: (key: string) => {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // Ignore.
        }
      },
    }
  : createMemoryStore();
