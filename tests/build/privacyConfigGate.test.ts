/** @jest-environment node */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-privacy-config.mjs');

function runGate(targetRoot: string): { status: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, '--root', targetRoot], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error: any) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}

function createFixtureRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickpic-privacy-gate-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets', 'ml'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets', 'images'), { recursive: true });

  fs.copyFileSync(
    path.join(repoRoot, 'app.json'),
    path.join(dir, 'app.json'),
  );
  fs.copyFileSync(
    path.join(repoRoot, 'package.json'),
    path.join(dir, 'package.json'),
  );
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'apply-privacy-patches.js'),
    path.join(dir, 'scripts', 'apply-privacy-patches.js'),
  );
  fs.copyFileSync(
    path.join(repoRoot, 'plugins', 'withPrivateRecordsBackup.js'),
    path.join(dir, 'plugins', 'withPrivateRecordsBackup.js'),
  );
  fs.writeFileSync(path.join(dir, 'assets', 'ml', 'efficientnet-lite4.tflite'), 'stub');
  fs.writeFileSync(path.join(dir, 'assets', 'images', 'icon_new.png'), 'stub');
  return dir;
}

describe('static privacy configuration gate', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeFixture(): string {
    const dir = createFixtureRoot();
    tempDirs.push(dir);
    return dir;
  }

  it('passes against the actual repository configuration and assets', () => {
    const result = runGate(repoRoot);
    expect(result.status).toBe(0);
    expect(result.output).toContain('Static privacy configuration checks passed.');
  });

  it('rejects location or audio recording permissions in app.json', () => {
    const dir = makeFixture();
    const appJsonPath = path.join(dir, 'app.json');
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    appJson.expo.android.permissions.push(
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.RECORD_AUDIO',
    );
    fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2));

    const result = runGate(dir);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('ACCESS_FINE_LOCATION');
    expect(result.output).toContain('RECORD_AUDIO');
  });

  it('rejects allowBackup !== false or media-location access enabled', () => {
    const dir = makeFixture();
    const appJsonPath = path.join(dir, 'app.json');
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    appJson.expo.android.allowBackup = true;
    const mediaPlugin = appJson.expo.plugins.find(
      (entry: unknown) => Array.isArray(entry) && entry[0] === 'expo-media-library',
    );
    mediaPlugin[1].isAccessMediaLocationEnabled = true;
    fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2));

    const result = runGate(dir);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('allowBackup');
    expect(result.output).toContain('isAccessMediaLocationEnabled');
  });

  it('rejects unpinned privacy-patched dependencies or missing buildFromSource entries', () => {
    const dir = makeFixture();
    const pkgJsonPath = path.join(dir, 'package.json');
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    pkgJson.dependencies['expo-media-library'] = '~18.2.1';
    pkgJson.expo.autolinking.android.buildFromSource = ['expo-image'];
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));

    const result = runGate(dir);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('expo-media-library');
    expect(result.output).toContain('buildFromSource');
  });

  it('rejects dead ML models, placeholders, and unused template images', () => {
    const dir = makeFixture();
    fs.writeFileSync(path.join(dir, 'assets', 'ml', 'mobilenet_v2.tflite'), 'dead');
    fs.writeFileSync(path.join(dir, 'assets', 'ml', 'labels.txt.placeholder'), 'dead');
    fs.writeFileSync(path.join(dir, 'assets', 'images', 'react-logo.png'), 'dead');

    const result = runGate(dir);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('mobilenet_v2.tflite');
    expect(result.output).toContain('labels.txt.placeholder');
    expect(result.output).toContain('react-logo.png');
  });
});
