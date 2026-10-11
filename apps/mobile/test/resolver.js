const reactNativeResolver = require("@react-native/jest-preset/jest/resolver");

// Wraps React Native's Jest resolver with the fallback metro.config.js adds:
// a relative `.js` import from a workspace source outside node_modules, such
// as @agentdesk/contract, that does not resolve is retried without the
// extension so Jest finds the `.ts` file.
module.exports = (path, options) => {
  try {
    return reactNativeResolver(path, options);
  } catch (error) {
    const fromWorkspaceSource = !options.basedir.includes("/node_modules/");
    if (fromWorkspaceSource && path.startsWith(".") && path.endsWith(".js")) {
      return reactNativeResolver(path.slice(0, -3), options);
    }
    throw error;
  }
};
