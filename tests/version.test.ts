import { APP_VERSION } from '../stores/useSettingsStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

it('keeps application and announcement versions aligned without changing dependency versions', () => {
  const pkg = require('../package.json');
  const config = require('../app.json');
  const lock = require('../package-lock.json');
  expect(pkg.version).toBe('0.4.0');
  expect(config.expo.version).toBe(pkg.version);
  expect(lock.version).toBe(pkg.version);
  expect(lock.packages[''].version).toBe(pkg.version);
  expect(APP_VERSION).toBe(`v${pkg.version}`);
  expect(pkg.license).toBe('Apache-2.0');
  expect(lock.packages[''].license).toBe(pkg.license);
});
