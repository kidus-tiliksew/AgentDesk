import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { removeAllDevices } from "./devices";
import { notifications } from "./refs";
import { devicesOf, register, setup, tokenStatus } from "./test.setup";

const unauthenticated = { data: { code: "unauthenticated" } };
const invalid = { data: { code: "invalid" } };

// Fake timers keep the push component's scheduled sender from running.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
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
