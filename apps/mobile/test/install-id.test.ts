import { ensureInstallId, INSTALL_ID_KEY, readInstallId } from "../src/install-id";
import { secureStore } from "./fakes";

// component-mobile-app §Notifications: the install id in secure storage.

describe("install id", () => {
  test("creates and stores one id on first use and reads it back afterwards", async () => {
    const first = await ensureInstallId();

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(secureStore.values.get(INSTALL_ID_KEY)).toBe(first);
    // A later launch reads the stored id rather than creating one.
    expect(await ensureInstallId()).toBe(first);
    expect(await readInstallId()).toBe(first);
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  test("concurrent first uses store and return one id", async () => {
    const ids = await Promise.all([ensureInstallId(), ensureInstallId(), readInstallId()]);

    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[0]);
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  test("reads no id before one is created", async () => {
    expect(await readInstallId()).toBeNull();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  test("a storage read failure rejects instead of returning an id or null", async () => {
    secureStore.failReads = true;

    await expect(ensureInstallId()).rejects.toThrow("Keychain unavailable");
    await expect(readInstallId()).rejects.toThrow("Keychain unavailable");
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  test("a storage write failure rejects, and a later attempt creates the id", async () => {
    secureStore.failWrites = true;
    await expect(ensureInstallId()).rejects.toThrow("Keychain unavailable");
    expect(await readInstallId()).toBeNull();

    secureStore.failWrites = false;
    const id = await ensureInstallId();
    expect(secureStore.values.get(INSTALL_ID_KEY)).toBe(id);
  });
});
