import { defineConfig } from "astro/config";

// component-website §Package: static output with no adapter and no UI framework
// integration. Vercel serves dist/ and applies the /install redirect from
// vercel.json (DEC-14).
export default defineConfig({
  site: "https://agentdesk.kidus.sh",
});
