import pushNotifications from "@convex-dev/expo-push-notifications/convex.config";
import { defineApp } from "convex/server";

// component-backend-foundation §Composition (DEC-7).
const app = defineApp();
app.use(pushNotifications);

export default app;
