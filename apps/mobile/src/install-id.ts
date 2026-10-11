import { randomUUID } from "expo-crypto";
import { getItemAsync, setItemAsync } from "expo-secure-store";

// component-mobile-app §Notifications: the install's stable id, the
// `deviceId` that `registerDevice` and `unregisterDevice` key on (DEC-7). It
// lives in secure storage, so it survives restarts and sign-outs, and nothing
// in the app deletes it.
export const INSTALL_ID_KEY = "agentdesk.installId";

// The one creation in flight. Concurrent callers share it, so two
// initializations cannot store two ids.
let creating: Promise<string> | null = null;

// Returns the stored id, creating and storing one on first use. The id is
// stored before it is returned, so no caller can register an id that a later
// launch would not read back. A storage failure rejects; there is no
// in-memory fallback id.
export function ensureInstallId(): Promise<string> {
  if (creating === null) {
    creating = (async () => {
      const stored = await getItemAsync(INSTALL_ID_KEY);
      if (stored !== null && stored !== "") {
        return stored;
      }
      const id = randomUUID();
      await setItemAsync(INSTALL_ID_KEY, id);
      return id;
    })().finally(() => {
      creating = null;
    });
  }
  return creating;
}

// Returns the stored id, or null when none was ever stored. It waits for a
// creation in flight first. A storage failure rejects rather than reading as
// null, because null means no device to unregister.
export async function readInstallId(): Promise<string | null> {
  await creating?.catch(() => undefined);
  const stored = await getItemAsync(INSTALL_ID_KEY);
  return stored === "" ? null : stored;
}
