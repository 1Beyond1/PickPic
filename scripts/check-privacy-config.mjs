// Static privacy red-line gate for CI and pre-release checks.
// Verifies permissions, backup exclusion, native source builds, exact pinning
// of privacy-patched SDK dependencies, and absence of dead bundled assets.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_PERMISSION_PATTERNS = [
  /LOCATION/i,
  /RECORD_AUDIO/i,
  /CAPTURE_AUDIO_OUTPUT/i,
  /MODIFY_AUDIO_SETTINGS/i,
  /READ_MEDIA_AUDIO/i,
  /SYSTEM_ALERT_WINDOW/i,
  /MANAGE_EXTERNAL_STORAGE/i,
  /\bCAMERA\b/i,
  /READ_CONTACTS/i,
  /READ_PHONE_STATE/i,
  /READ_SMS/i,
  /READ_CALL_LOG/i,
];

const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REQUIRED_BUILD_FROM_SOURCE = ['expo-image', 'expo-media-library'];
const ALLOWED_TFLITE_MODELS = new Set(['efficientnet-lite4.tflite']);
const FORBIDDEN_IMAGE_PATTERNS = [
  /^react-logo(?:@\dx)?\.png$/i,
  /^partial-react-logo\.png$/i,
  /^icon_new\.jpg$/i,
  /^android-icon-(?:background|foreground|monochrome)\.png$/i,
  /^splash-icon\.png$/i,
  /^icon\.png$/i,
];

function readJson(filePath, label, errors) {
  if (!fs.existsSync(filePath)) {
    errors.push(`Missing required file: ${label}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    errors.push(`Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function findPluginEntry(plugins, pluginName) {
  if (!Array.isArray(plugins)) return null;
  for (const entry of plugins) {
    if (entry === pluginName) return { name: pluginName, options: {} };
    if (Array.isArray(entry) && entry[0] === pluginName) {
      return { name: pluginName, options: entry[1] ?? {} };
    }
  }
  return null;
}

function loadPatchedDependencyVersions(rootDir, errors) {
  const patchScriptPath = path.join(rootDir, 'scripts', 'apply-privacy-patches.js');
  if (!fs.existsSync(patchScriptPath)) {
    errors.push('Missing scripts/apply-privacy-patches.js');
    return null;
  }
  try {
    const require = createRequire(import.meta.url);
    const { versions } = require(patchScriptPath);
    if (!versions || typeof versions !== 'object' || Object.keys(versions).length === 0) {
      errors.push('scripts/apply-privacy-patches.js did not export a non-empty versions map');
      return null;
    }
    return versions;
  } catch (error) {
    errors.push(`Could not load scripts/apply-privacy-patches.js: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function checkPrivacyConfig(rootDir) {
  const errors = [];

  const appJson = readJson(path.join(rootDir, 'app.json'), 'app.json', errors);
  const pkgJson = readJson(path.join(rootDir, 'package.json'), 'package.json', errors);
  const lockPath = path.join(rootDir, 'package-lock.json');
  const lockJson = fs.existsSync(lockPath) ? readJson(lockPath, 'package-lock.json', errors) : null;
  const patchedVersions = loadPatchedDependencyVersions(rootDir, errors);

  // 1. app.json permissions, backup exclusion, and privacy plugins
  const expoConfig = appJson?.expo;
  if (!expoConfig || typeof expoConfig !== 'object') {
    errors.push('app.json must contain a top-level "expo" object');
  } else {
    const androidConfig = expoConfig.android;
    if (!androidConfig || typeof androidConfig !== 'object') {
      errors.push('app.json must contain "expo.android" configuration');
    } else {
      if (androidConfig.allowBackup !== false) {
        errors.push('app.json must set expo.android.allowBackup to false');
      }

      const permissions = androidConfig.permissions;
      if (!Array.isArray(permissions)) {
        errors.push('app.json must explicitly declare expo.android.permissions');
      } else {
        for (const permission of permissions) {
          if (typeof permission !== 'string') {
            errors.push('app.json expo.android.permissions entries must be strings');
            continue;
          }
          for (const pattern of FORBIDDEN_PERMISSION_PATTERNS) {
            if (pattern.test(permission)) {
              errors.push(`Forbidden Android permission in app.json: ${permission}`);
              break;
            }
          }
        }
      }
    }

    const plugins = expoConfig.plugins;
    const mediaPlugin = findPluginEntry(plugins, 'expo-media-library');
    if (!mediaPlugin || mediaPlugin.options?.isAccessMediaLocationEnabled !== false) {
      errors.push('app.json must configure expo-media-library with isAccessMediaLocationEnabled: false');
    }

    const secureStorePlugin = findPluginEntry(plugins, 'expo-secure-store');
    if (!secureStorePlugin || secureStorePlugin.options?.configureAndroidBackup !== false) {
      errors.push('app.json must configure expo-secure-store with configureAndroidBackup: false');
    }

    const sqlitePlugin = findPluginEntry(plugins, 'expo-sqlite');
    if (!sqlitePlugin || sqlitePlugin.options?.useSQLCipher !== true) {
      errors.push('app.json must configure expo-sqlite with useSQLCipher: true');
    }

    const backupPlugin = findPluginEntry(plugins, './plugins/withPrivateRecordsBackup');
    if (!backupPlugin) {
      errors.push('app.json must register ./plugins/withPrivateRecordsBackup');
    }
  }

  // 2. Native backup-exclusion config plugin guard & generated AndroidManifest audit
  const backupPluginFile = path.join(rootDir, 'plugins', 'withPrivateRecordsBackup.js');
  if (!fs.existsSync(backupPluginFile)) {
    errors.push('Missing plugins/withPrivateRecordsBackup.js');
  } else {
    const pluginSource = fs.readFileSync(backupPluginFile, 'utf8');
    if (!pluginSource.includes("application['android:allowBackup'] = 'false'")) {
      errors.push("plugins/withPrivateRecordsBackup.js must force android:allowBackup='false'");
    }
    if (!pluginSource.includes('isExcludedFromBackup = true')) {
      errors.push('plugins/withPrivateRecordsBackup.js must exclude iOS directories from backup');
    }
  }

  const generatedManifestPath = path.join(rootDir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (fs.existsSync(generatedManifestPath)) {
    const manifestSource = fs.readFileSync(generatedManifestPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const permissionTagRegex = /<uses-permission(?:-sdk-23)?\b[^>]*>/gi;
    for (const match of manifestSource.matchAll(permissionTagRegex)) {
      const tag = match[0];
      if (/\btools:node\s*=\s*["']remove["']/i.test(tag)) continue;
      const nameMatch = tag.match(/\bandroid:name\s*=\s*["']([^"']+)["']/i);
      if (!nameMatch) continue;
      const permission = nameMatch[1];
      for (const pattern of FORBIDDEN_PERMISSION_PATTERNS) {
        if (pattern.test(permission)) {
          errors.push(`Forbidden Android permission in android/app/src/main/AndroidManifest.xml: ${permission}`);
          break;
        }
      }
    }

    const applicationMatch = manifestSource.match(/<application\b[^>]*>/i);
    if (!applicationMatch) {
      errors.push('android/app/src/main/AndroidManifest.xml is missing an <application> tag');
    } else {
      const appTag = applicationMatch[0];
      const allowBackupMatch = appTag.match(/\bandroid:allowBackup\s*=\s*["']([^"']+)["']/i);
      if (!allowBackupMatch || allowBackupMatch[1].toLowerCase() !== 'false') {
        errors.push(
          `android/app/src/main/AndroidManifest.xml must set android:allowBackup="false" (found ${JSON.stringify(allowBackupMatch?.[1] ?? null)})`
        );
      }
      if (!/\bandroid:fullBackupContent\s*=\s*["']@xml\/pickpic_backup_rules["']/i.test(appTag)) {
        errors.push('android/app/src/main/AndroidManifest.xml must set android:fullBackupContent="@xml/pickpic_backup_rules"');
      }
      if (!/\bandroid:dataExtractionRules\s*=\s*["']@xml\/pickpic_data_extraction_rules["']/i.test(appTag)) {
        errors.push('android/app/src/main/AndroidManifest.xml must set android:dataExtractionRules="@xml/pickpic_data_extraction_rules"');
      }
    }
  }

  // 3. package.json buildFromSource & exact pinning of privacy-patched / source-built SDKs
  if (pkgJson) {
    const deps = pkgJson.dependencies ?? {};
    const lockPackages = lockJson?.packages && typeof lockJson.packages === 'object' ? lockJson.packages : null;
    const lockRootDeps = lockPackages?.['']?.dependencies ?? null;
    const buildFromSource = pkgJson.expo?.autolinking?.android?.buildFromSource;
    if (!Array.isArray(buildFromSource)) {
      errors.push('package.json must set expo.autolinking.android.buildFromSource');
    } else {
      for (const requiredModule of REQUIRED_BUILD_FROM_SOURCE) {
        if (!buildFromSource.includes(requiredModule)) {
          errors.push(`package.json buildFromSource must include "${requiredModule}"`);
        }
        const declared = deps[requiredModule];
        if (typeof declared !== 'string' || !EXACT_SEMVER_PATTERN.test(declared)) {
          errors.push(
            `Source-built dependency "${requiredModule}" must be pinned to an exact version in package.json (found ${JSON.stringify(declared)})`
          );
        } else if (lockPackages) {
          const resolvedVersion = lockPackages[`node_modules/${requiredModule}`]?.version;
          if (resolvedVersion !== declared) {
            errors.push(
              `Source-built dependency "${requiredModule}" must resolve to "${declared}" in package-lock.json (found ${JSON.stringify(resolvedVersion)})`
            );
          }
          if (lockRootDeps && lockRootDeps[requiredModule] !== declared) {
            errors.push(
              `Source-built dependency "${requiredModule}" root lock entry must match "${declared}" in package-lock.json (found ${JSON.stringify(lockRootDeps[requiredModule])})`
            );
          }
        }
      }
    }

    if (patchedVersions) {
      for (const [depName, expectedVersion] of Object.entries(patchedVersions)) {
        const declared = deps[depName];
        if (declared !== expectedVersion) {
          errors.push(
            `Privacy-patched dependency "${depName}" must be pinned exactly to "${expectedVersion}" in package.json (found ${JSON.stringify(declared)})`
          );
        }
        if (lockPackages) {
          const resolvedVersion = lockPackages[`node_modules/${depName}`]?.version;
          if (resolvedVersion !== expectedVersion) {
            errors.push(
              `Privacy-patched dependency "${depName}" must resolve to "${expectedVersion}" in package-lock.json (found ${JSON.stringify(resolvedVersion)})`
            );
          }
          if (lockRootDeps && lockRootDeps[depName] !== expectedVersion) {
            errors.push(
              `Privacy-patched dependency "${depName}" root lock entry must match "${expectedVersion}" in package-lock.json (found ${JSON.stringify(lockRootDeps[depName])})`
            );
          }
        }
      }
    }
  }

  // 4. Dead ML models & unused template assets guard
  const mlDir = path.join(rootDir, 'assets', 'ml');
  if (fs.existsSync(mlDir)) {
    const mlEntries = fs.readdirSync(mlDir, { withFileTypes: true });
    for (const entry of mlEntries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.placeholder')) {
        errors.push(`Placeholder asset must not be bundled in assets/ml/: ${entry.name}`);
      } else if (entry.name.endsWith('.tflite') && !ALLOWED_TFLITE_MODELS.has(entry.name)) {
        errors.push(`Unused or unapproved ML model in assets/ml/: ${entry.name}`);
      }
    }
  }

  const imagesDir = path.join(rootDir, 'assets', 'images');
  if (fs.existsSync(imagesDir)) {
    const imageEntries = fs.readdirSync(imagesDir, { withFileTypes: true });
    for (const entry of imageEntries) {
      if (!entry.isFile()) continue;
      for (const pattern of FORBIDDEN_IMAGE_PATTERNS) {
        if (pattern.test(entry.name)) {
          errors.push(`Unused template image must not remain in assets/images/: ${entry.name}`);
          break;
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function resolveCliRoot(argv) {
  const flagIndex = argv.indexOf('--root');
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    return path.resolve(argv[flagIndex + 1]);
  }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, '..');
}

const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  const rootDir = resolveCliRoot(process.argv.slice(2));
  const result = checkPrivacyConfig(rootDir);
  if (result.ok) {
    console.log('Static privacy configuration checks passed.');
  } else {
    for (const error of result.errors) {
      console.error(`[privacy-gate] ${error}`);
    }
    process.exitCode = 1;
  }
}
