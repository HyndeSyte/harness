// Metro bundles the one canonical form from surface/shared, which the exporter and the
// Worker import too (surface/README.md). Nothing else outside the app is watched.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders || []), path.resolve(__dirname, "../shared")];
module.exports = config;
