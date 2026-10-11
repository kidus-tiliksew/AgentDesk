// expo-router/testing-library registers its route matchers on `expect` at
// runtime but ships no types for them. This declares the one the tests use.
declare global {
  namespace jest {
    interface Matchers<R> {
      toHavePathname(pathname: string): R;
    }
  }
}

export {};
