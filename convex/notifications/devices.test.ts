import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { removeAllDevices } from "./devices";
import { notifications } from "./refs";
import {
  devicesOf,
  notification,
  pendingDrains,
  queued,
  queueHistory,
  queuePush,
  register,
  setup,
  tokenHistory,
  tokenRecords,
  tokenStatus,
} from "./test.setup";

const unauthenticated = { data: { code: "unauthenticated" } };
const invalid = { data: { code: "invalid" } };

// Fake timers keep the push component's scheduled sender from running.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("registerDevice", () => {
  test("stores the device for the signed-in person and records its token", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[a]");

    const devices = await devicesOf(t);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      userId: userA,
      deviceId: "install-1",
      name: "Phone install-1",
      platform: "ios",
    });
    expect(await tokenStatus(t, "install-1")).toMatchObject({ hasToken: true });
  });

  test("re-registering replaces the token and keeps one row", async () => {
    const { t, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[a]");
    await asA.mutation(notifications.devices.registerDevice, {
      deviceId: "install-1",
      pushToken: "ExponentPushToken[b]",
      platform: "android",
      name: "Renamed",
    });

    const devices = await devicesOf(t);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ name: "Renamed", platform: "android" });
    expect(await tokenStatus(t, "install-1")).toMatchObject({ hasToken: true });
  });

  test("moves an install from one account to another", async () => {
    const { t, userB, asA, asB } = await setup();
    await register(asA, "install-1", "ExponentPushToken[a]");
    await register(asB, "install-1", "ExponentPushToken[b]");

    const devices = await devicesOf(t);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ userId: userB, deviceId: "install-1" });

    // A stale sign-out from the former owner leaves the new owner's row and
    // token in place.
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-1" });
    expect(await devicesOf(t)).toHaveLength(1);
    expect(await tokenStatus(t, "install-1")).toMatchObject({ hasToken: true });
  });

  test("refuses an empty device id or push token", async () => {
    const { t, asA } = await setup();
    await expect(register(asA, "", "ExponentPushToken[a]")).rejects.toMatchObject(invalid);
    await expect(register(asA, "install-1", "")).rejects.toMatchObject(invalid);
    expect(await devicesOf(t)).toHaveLength(0);
    expect(await tokenStatus(t, "install-1")).toMatchObject({ hasToken: false });
  });

  test("refuses a caller who is not signed in", async () => {
    const { t } = await setup();
    await expect(register(t, "install-1", "ExponentPushToken[a]")).rejects.toMatchObject(
      unauthenticated,
    );
    expect(await devicesOf(t)).toHaveLength(0);
    expect(await tokenStatus(t, "install-1")).toMatchObject({ hasToken: false });
  });
});

describe("unregisterDevice", () => {
  test("deletes the owned row and its token", async () => {
    const { t, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[a]");
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-1" });

    expect(await devicesOf(t)).toHaveLength(0);
    expect(await tokenStatus(t, "install-1")).toMatchObject({ hasToken: false });
  });

  test("leaves another account's install unchanged", async () => {
    const { t, userB, asA, asB } = await setup();
    await register(asB, "install-b", "ExponentPushToken[b]");
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-b" });
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "unknown" });

    const devices = await devicesOf(t);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ userId: userB, deviceId: "install-b" });
    expect(await tokenStatus(t, "install-b")).toMatchObject({ hasToken: true });
  });

  test("refuses a caller who is not signed in", async () => {
    const { t, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[a]");
    await expect(
      t.mutation(notifications.devices.unregisterDevice, { deviceId: "install-1" }),
    ).rejects.toMatchObject(unauthenticated);
    expect(await devicesOf(t)).toHaveLength(1);
    expect(await tokenStatus(t, "install-1")).toMatchObject({ hasToken: true });
  });
});

describe("removeAllDevices", () => {
  test("removes every device and token of one account only", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-a1", "ExponentPushToken[a1]");
    await register(asA, "install-a2", "ExponentPushToken[a2]");
    await register(asB, "install-b", "ExponentPushToken[b]");

    await t.run((ctx) => removeAllDevices(ctx, userA));

    const devices = await devicesOf(t);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ userId: userB, deviceId: "install-b" });
    expect(await tokenStatus(t, "install-a1")).toMatchObject({ hasToken: false });
    expect(await tokenStatus(t, "install-a2")).toMatchObject({ hasToken: false });
    expect(await tokenStatus(t, "install-b")).toMatchObject({ hasToken: true });
  });
});

// component-notifications §Devices: an install that leaves an account, by
// sign-out or by moving to another account, takes none of the account's
// notifications with it. Fake timers keep the component's sender from
// running, so every notification here is still queued.
describe("sign-out cancels the install's notifications", () => {
  test("deletes every queued notification and the token in the mutation transaction", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[a]");
    await queuePush(t, userA, "First");
    await queuePush(t, userA, "Second");
    const ids = (await queued(t, "install-1")).map((row) => row.id);
    expect(ids).toHaveLength(2);

    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-1" });

    for (const id of ids) {
      expect(await notification(t, id)).toBeNull();
    }
    expect(await tokenHistory(t, "ExponentPushToken[a]")).toHaveLength(0);
    expect(await tokenStatus(t, "install-1")).toMatchObject({ hasToken: false });
    expect(await devicesOf(t)).toHaveLength(0);
    expect(await tokenRecords(t, userA)).toHaveLength(0);
    expect(await pendingDrains(t)).toHaveLength(0);
  });

  test("covers notifications under tokens an earlier refresh replaced", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[a1]");
    await queuePush(t, userA, "Under the first token");
    const [early] = await queued(t, "install-1");
    // The app reports a new token for the same install.
    await register(asA, "install-1", "ExponentPushToken[a2]");
    await queuePush(t, userA, "Under the second token");
    const [late] = await queued(t, "install-1");
    if (early === undefined || late === undefined) {
      throw new Error("No queued push");
    }
    // The refresh kept the first token's notification.
    expect(await notification(t, early.id)).not.toBeNull();

    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-1" });

    expect(await notification(t, early.id)).toBeNull();
    expect(await notification(t, late.id)).toBeNull();
    expect(await tokenRecords(t, userA)).toHaveLength(0);
    expect(await pendingDrains(t)).toHaveLength(0);
  });

  test("leaves the account's other installs and other accounts unchanged", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-1", "ExponentPushToken[a1]");
    await register(asA, "install-2", "ExponentPushToken[a2]");
    await register(asB, "install-b", "ExponentPushToken[b]");
    await queuePush(t, userA, "For A");
    await queuePush(t, userB, "For B");
    const [onOther] = await queued(t, "install-2");
    const [forB] = await queued(t, "install-b");
    if (onOther === undefined || forB === undefined) {
      throw new Error("No queued push");
    }

    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-1" });

    expect(await tokenHistory(t, "ExponentPushToken[a1]")).toHaveLength(0);
    expect(await notification(t, onOther.id)).toMatchObject({ state: "awaiting_delivery" });
    expect(await notification(t, forB.id)).toMatchObject({ state: "awaiting_delivery" });
    expect(await tokenStatus(t, "install-2")).toMatchObject({ hasToken: true });
    expect(await tokenStatus(t, "install-b")).toMatchObject({ hasToken: true });
    expect((await tokenRecords(t, userA)).map((row) => row.deviceId)).toEqual(["install-2"]);
    expect(await tokenRecords(t, userB)).toHaveLength(1);
    // Later pushes still reach the remaining installs only.
    await queuePush(t, userA, "Later");
    expect(await queued(t, "install-2")).toHaveLength(2);
  });

  test("a repeated or foreign sign-out changes nothing more", async () => {
    const { t, userB, asA, asB } = await setup();
    await register(asA, "install-1", "ExponentPushToken[a]");
    await register(asB, "install-b", "ExponentPushToken[b]");
    await queuePush(t, userB, "For B");
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-1" });
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-1" });
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-b" });

    expect(await queued(t, "install-b")).toHaveLength(1);
    expect(await tokenRecords(t, userB)).toHaveLength(1);
    expect(await pendingDrains(t)).toHaveLength(0);
  });
});

describe("a token refresh keeps the install's notifications", () => {
  test("the same token and a new token both keep the history", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[a]");
    await queuePush(t, userA, "First");
    const [first] = await queued(t, "install-1");
    if (first === undefined) {
      throw new Error("No queued push");
    }

    await register(asA, "install-1", "ExponentPushToken[a]");
    expect(await notification(t, first.id)).toMatchObject({ state: "awaiting_delivery" });
    expect(await tokenRecords(t, userA)).toHaveLength(1);

    await asA.mutation(notifications.devices.registerDevice, {
      deviceId: "install-1",
      pushToken: "ExponentPushToken[a2]",
      platform: "android",
      name: "Renamed",
    });
    expect(await notification(t, first.id)).toMatchObject({ state: "awaiting_delivery" });
    expect(await devicesOf(t)).toEqual([
      expect.objectContaining({ userId: userA, name: "Renamed", platform: "android" }),
    ]);
    expect((await tokenRecords(t, userA)).map((row) => row.token)).toEqual([
      "ExponentPushToken[a]",
      "ExponentPushToken[a2]",
    ]);
    expect(await pendingDrains(t)).toHaveLength(0);
  });
});

describe("an install moving to another account", () => {
  test("with a new token leaves none of the former owner's notifications", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-1", "ExponentPushToken[a]");
    await queuePush(t, userA, "For A");

    await register(asB, "install-1", "ExponentPushToken[b]");
    await queuePush(t, userB, "For B");

    expect(await tokenHistory(t, "ExponentPushToken[a]")).toHaveLength(0);
    expect(await tokenRecords(t, userA)).toHaveLength(0);
    expect((await queued(t, "install-1")).map((row) => row.title)).toEqual(["For B"]);
    expect(await pendingDrains(t)).toHaveLength(0);
  });

  test("with the same Expo token leaves none of the former owner's notifications", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-1", "ExponentPushToken[shared]");
    await queuePush(t, userA, "For A");
    await queuePush(t, userA, "Again for A");

    await register(asB, "install-1", "ExponentPushToken[shared]");
    await queuePush(t, userB, "For B");

    expect((await tokenHistory(t, "ExponentPushToken[shared]")).map((row) => row.title)).toEqual([
      "For B",
    ]);
    expect(await tokenRecords(t, userA)).toHaveLength(0);
    expect(await tokenRecords(t, userB)).toHaveLength(1);
    expect(await pendingDrains(t)).toHaveLength(0);
  });

  test("deletes a history of several pages before the new owner takes the shared token", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-1", "ExponentPushToken[shared]");
    await queueHistory(t, userA, "install-1", 1500);

    await register(asB, "install-1", "ExponentPushToken[shared]");
    await queuePush(t, userB, "For B");

    expect((await tokenHistory(t, "ExponentPushToken[shared]")).map((row) => row.title)).toEqual([
      "For B",
    ]);
    expect(await tokenRecords(t, userA)).toHaveLength(0);
    expect(await pendingDrains(t)).toHaveLength(0);
  }, 30_000);

  test("after the former owner signed out keeps the new owner's notifications", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-1", "ExponentPushToken[shared]");
    await queuePush(t, userA, "For A");
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-1" });
    await register(asB, "install-1", "ExponentPushToken[shared]");
    await queuePush(t, userB, "For B");

    // A stale sign-out from the former owner changes nothing.
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-1" });

    expect((await queued(t, "install-1")).map((row) => row.title)).toEqual(["For B"]);
    expect(await tokenRecords(t, userA)).toHaveLength(0);
    expect(await tokenRecords(t, userB)).toHaveLength(1);
  });
});
