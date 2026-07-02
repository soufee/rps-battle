const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Watch the shared directory outside of client
config.watchFolders = [
  path.resolve(__dirname, '../shared'),
];

// Force resolver to look into node_modules of client first
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
];

module.exports = config;
