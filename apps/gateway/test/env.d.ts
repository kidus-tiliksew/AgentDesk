// Types `exports` from "cloudflare:workers" as the Worker's main module.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index.js");
  }
}
