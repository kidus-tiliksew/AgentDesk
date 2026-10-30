// expo-router/testing-library registers its route matchers on `expect` at
// runtime but ships no types for them. This declares the ones the tests use.
declare global {
  namespace jest {
    interface Matchers<R> {
      toHavePathname(pathname: string): R;
      toHaveSearchParams(params: Record<string, string | string[]>): R;
    }
  }
}

export {};
