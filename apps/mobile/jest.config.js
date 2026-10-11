// component-mobile-app §Verification: Jest with jest-expo and React Native
// Testing Library. jest-expo's preset already transforms packages under
// pnpm's node_modules/.pnpm.
module.exports = {
  preset: "jest-expo",
  resolver: "<rootDir>/test/resolver.js",
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
  testMatch: ["<rootDir>/test/**/*.test.ts?(x)"],
};
