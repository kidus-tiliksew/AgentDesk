// The Convex function modules for convex-test, keyed by path relative to this
// file. The pattern skips files with more than one dot, such as tests and
// configuration, the same files the Convex bundler skips.
export const modules = import.meta.glob(["../**/*.*s", "!../**/*.*.*s"]);

// Vite provides import.meta.glob to Vitest; the backend does not depend on
// Vite's type package, so the one method used here is declared locally.
declare global {
  interface ImportMeta {
    glob(patterns: string[]): Record<string, () => Promise<unknown>>;
  }
}
