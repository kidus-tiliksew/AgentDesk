import { screen } from "expo-router/testing-library";
import { ensureAccount } from "./fakes";
import { renderApp } from "./render";

describe("configuration", () => {
  test("names both variables when both are missing and mounts no provider", () => {
    delete process.env.EXPO_PUBLIC_CONVEX_URL;
    delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

    renderApp("/");

    expect(screen.getByText("AgentDesk is not configured")).toBeOnTheScreen();
    expect(screen.getByText("EXPO_PUBLIC_CONVEX_URL")).toBeOnTheScreen();
    expect(screen.getByText("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Email address")).not.toBeOnTheScreen();
    expect(ensureAccount).not.toHaveBeenCalled();
  });

  test("names only the missing Clerk key", () => {
    delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

    renderApp("/");

    expect(screen.getByText("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBeOnTheScreen();
    expect(screen.queryByText("EXPO_PUBLIC_CONVEX_URL")).not.toBeOnTheScreen();
  });

  test("treats a blank Convex URL as missing", () => {
    process.env.EXPO_PUBLIC_CONVEX_URL = "  ";

    renderApp("/");

    expect(screen.getByText("EXPO_PUBLIC_CONVEX_URL")).toBeOnTheScreen();
    expect(screen.queryByText("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY")).not.toBeOnTheScreen();
  });
});
