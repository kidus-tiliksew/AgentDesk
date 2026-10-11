const { getDefaultConfig } = require("expo/metro-config");

// Expo's default configuration finds the pnpm workspace root, watches it, and
// resolves workspace packages through their symlinks.
const config = getDefaultConfig(__dirname);

// Workspace TypeScript sources, such as @agentdesk/contract, import sibling
// modules with NodeNext `.js` specifiers that name `.ts` files. When a relative
// `.js` import from a source outside node_modules does not resolve, retry it
// without the extension so Metro finds the `.ts` file.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (error) {
    const fromWorkspaceSource = !context.originModulePath.includes("/node_modules/");
    if (fromWorkspaceSource && moduleName.startsWith(".") && moduleName.endsWith(".js")) {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    }
    throw error;
  }
};

module.exports = config;
