import { useAuth } from "@clerk/expo";
import { Redirect, Stack } from "expo-router";
import { Loading } from "../../src/loading";

// Signed-out routes. A signed-in person is sent to the app.
export default function AuthLayout() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) {
    return <Loading label="Loading" />;
  }
  if (isSignedIn) {
    return <Redirect href="/" />;
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}
