const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add bundled model and SQLite WebAssembly files to asset extensions.
for (const extension of ['tflite', 'wasm']) {
  if (!config.resolver.assetExts.includes(extension)) {
    config.resolver.assetExts.push(extension);
  }
}

// Zustand's ESM middleware contains `import.meta.env`, but Metro emits the
// web bundle as a classic script. Resolve this one module to its CommonJS
// entry on web so the generated bundle remains valid JavaScript. Keep the
// platform-specific override narrow so native package resolution is unchanged.
const zustandMiddleware = require.resolve('zustand/middleware');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'zustand/middleware') {
    return {
      type: 'sourceFile',
      filePath: zustandMiddleware,
    };
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
