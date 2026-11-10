// UI tests: the real screens, rendered with React Native Testing Library. The plain-TypeScript tests in test/ run on Vitest.
const PKGS = '(jest-)?react-native|@react-native|@react-native-community|expo|@expo|react-navigation|@react-navigation|react-native-svg|react-native-reanimated|react-native-worklets|react-native-gesture-handler|react-native-screens|react-native-safe-area-context|test-renderer|@testing-library'
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/ui-test/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/ui-test/setup.ts'],
  // pnpm keeps packages under node_modules/.pnpm/<name>@<version>/node_modules/<name>, so both layers are let through for these.
  transformIgnorePatterns: [
    '/node_modules/(?!(\\.pnpm|' + PKGS + ')/?)',
    '/node_modules/\\.pnpm/(?!(' + PKGS + ')[^/]*/)',
  ],
}
