const expoPreset = require('jest-expo/jest-preset');
const [babelTransformer, babelOptions] = expoPreset.transform['\\.[jt]sx?$'];

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  transform: {
    ...expoPreset.transform,
    '\\.[jt]sx?$': [babelTransformer, {
      ...babelOptions,
      plugins: [require.resolve('./tests/helpers/jestDynamicImportPlugin')],
    }],
  },
  testMatch: [
    '<rootDir>/tests/**/*.test.ts',
    '<rootDir>/tests/**/*.test.tsx',
  ],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 15000,
};
