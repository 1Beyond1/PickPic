// React 19 expects this flag for tests that exercise hooks and components.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

// Jest has no native binary. Exercise real portable scrypt here; the native
// adapter has its own contract tests and an Android build/runtime smoke test.
jest.mock('../services/backup/keyDerivation', () => jest.requireActual('../services/backup/keyDerivation.ts'));
