// component-mobile-app §Verification: Jest with jest-expo and React Native
// Testing Library. jest-expo's preset already transforms packages under
// pnpm's node_modules/.pnpm.
module.exports = {
  preset: "jest-expo",
  resolver: "<rootDir>/test/resolver.js",
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
  // Tests render the real route tree, native tabs included; the first test in
  // a file also pays the tree's warm-up, which takes longer than Jest's 5 s
  // default on CI runners.
  testTimeout: 20000,
  testMatch: ["<rootDir>/test/**/*.test.ts?(x)"],
};
