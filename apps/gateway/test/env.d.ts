// Types `exports` from "cloudflare:workers" as the Worker's main module.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index.js");
  }
}

// The test bundler's `?raw` import of a file as its text.
declare module "*?raw" {
  const text: string;
  export default text;
}
