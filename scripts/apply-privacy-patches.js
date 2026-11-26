// Narrow, version-checked SDK log redactions. No inference, permission,
// return-value, exception propagation or media operations are changed.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const core = '@infinitered/react-native-mlkit-core';
const labels = '@infinitered/react-native-mlkit-image-labeling';
const faces = '@infinitered/react-native-mlkit-face-detection';
const media = 'expo-media-library';
const versions = { [core]: '5.0.0', [labels]: '5.0.0', [faces]: '5.0.0', [media]: '18.2.1' };
const kotlinRoot = 'android/src/main/java/red/infinite/reactnativemlkit/';
const patches = [
  { package: core, file: `${kotlinRoot}core/RNMLKitImage.kt`, replacements: [
    ['Log.d("RNMLKit", "RNMLKitImage: Loading Image from $_imagePath")', 'Log.d("RNMLKit", "RNMLKitImage: Loading Image")'],
  ] },
  { package: core, file: `${kotlinRoot}core/RNMLKitLog.kt`, replacements: [
    ['Log.e(tag, message, throwable)', 'Log.e(tag, "Native analysis failed")'],
    ['Log.wtf(tag, message, throwable)', 'Log.wtf(tag, "Native analysis failed")'],
  ] },
  { package: labels, file: `${kotlinRoot}imagelabeling/RNMLKitImageLabeler.kt`, replacements: [
    ['Log.e("RNMLKitImageLabeler", e.localizedMessage ?: "Unknown error")', 'Log.e("RNMLKitImageLabeler", "Failed to initialize image labeler")'],
  ] },
  { package: labels, file: `${kotlinRoot}imagelabeling/RNMLKitImageLabelerMap.kt`, replacements: [
    ['Log.d("RNMLKit", "add: Loading model \'${spec.modelName}\' from ${spec.modelPath} with options ${spec.options}")', 'Log.d("RNMLKit", "add: Loading bundled model")'],
  ] },
  { package: labels, file: `${kotlinRoot}imagelabeling/RNMLKitImageLabelingModule.kt`, replacements: [
    ['"addModel: Loading model \'${spec.modelName}\' from ${spec.modelPath}"', '"addModel: Loading bundled model"'],
  ] },
  { package: labels, file: 'ios/RNMLKitImageLabelingModule.swift', replacements: [
    ['logger.debug("RNMLKit", "addModel: Loading model \'\\(spec.modelName)\' from \\(spec.modelPath)")', 'logger.debug("RNMLKit", "addModel: Loading bundled model")'],
    ['logger.info("RNMLKit", "classify image: Classifying image: \\(imagePath) ")', 'logger.info("RNMLKit", "classify image: Classifying image")'],
  ] },
  { package: faces, file: 'ios/RNMLKitFaceDetectionModule.swift', replacements: [
    ['logger.debug(result)', 'logger.debug("RNMLKitFaceDetection: Face detection completed")'],
  ] },
  { package: media, file: 'android/src/main/java/expo/modules/medialibrary/assets/AssetUtils.kt', replacements: [
    ['Log.w("expo-media-library", "Could not parse EXIF tags for $localUri")', 'Log.w("expo-media-library", "Could not parse EXIF tags")'],
    ['Log.w("expo-media-library", "Could not parse EXIF tags for $photoUri")', 'Log.w("expo-media-library", "Could not parse EXIF tags")'],
    ['e.printStackTrace()', '// PickPic: do not log provider exceptions containing media paths.', 2],
    ['Log.e("expo-media-library", "MediaMetadataRetriever unexpectedly returned non-integer: ${e.message}")', 'Log.e("expo-media-library", "MediaMetadataRetriever returned invalid dimensions")'],
    ['Log.e("expo-media-library", "ContentResolver failed to read $uri: ${e.message}")', 'Log.e("expo-media-library", "ContentResolver failed to read media")'],
    ['Log.e("expo-media-library", "MediaMetadataRetriever finished with unexpected error: ${e.message}")', 'Log.e("expo-media-library", "MediaMetadataRetriever failed")'],
  ] },
  ...['src/module/RNMLKitImageLabeler.ts', 'build/module/RNMLKitImageLabeler.js'].map(file => ({ package: labels, file, replacements: [
    ['console.error("Failed to load model: ", error)', 'console.error("Failed to load image model.")'],
  ] })),
  ...['src/hooks/useImageLabelingModels.ts', 'build/hooks/useImageLabelingModels.js'].map(file => ({ package: labels, file, replacements: [
    ['console.error("Failed to load models: ", error)', 'console.error("Failed to load image models.")'],
  ] })),
  ...['src/module/RNMLKitFaceDetector.ts', 'build/module/RNMLKitFaceDetector.js'].map(file => ({ package: faces, file, replacements: [
    ['console.error(e)', 'console.error("Failed to initialize face detector.")'],
    // Whitespace differs between TypeScript source and emitted JavaScript.
    ['console.error(\n        e instanceof Error\n          ? e.message\n          : "An unknown error occurred while detecting faces"\n      )', 'console.error("Face detection failed.")', 1, true],
    ['console.error(e instanceof Error\n                ? e.message\n                : "An unknown error occurred while detecting faces")', 'console.error("Face detection failed.")', 1, true],
    ['console.error(\n        e instanceof Error\n          ? e.message\n          : "An unknown error occurred while initializing the model"\n      )', 'console.error("Failed to initialize face detector.")', 1, true],
    ['console.error(e instanceof Error\n                ? e.message\n                : "An unknown error occurred while initializing the model")', 'console.error("Failed to initialize face detector.")', 1, true],
  ] })),
];

// SHA-256 of the reviewed, redacted complete files (LF-normalized). Matching
// only log anchors is insufficient: same-version upstream edits must not pass.
const reviewedSources = {
  [`${core}/${kotlinRoot}core/RNMLKitImage.kt`]: 'dd6b50192113e5c590c794e89d49a6dc2290b5068702f1a238b99438379f271b',
  [`${core}/${kotlinRoot}core/RNMLKitLog.kt`]: '0b2e12e33ad4bdef7b58b4cb73d66986b1908124492b6b762356e1f61bd96737',
  [`${labels}/${kotlinRoot}imagelabeling/RNMLKitImageLabeler.kt`]: 'af46060e9a84797f66f5a28bb11ccaee7d66efa89ccfea89210d5c2ef5226652',
  [`${labels}/${kotlinRoot}imagelabeling/RNMLKitImageLabelerMap.kt`]: '1a8dc817154ab5883fcb22110568a5375901cb9a5856445a4fb95ccf6595ad6b',
  [`${labels}/${kotlinRoot}imagelabeling/RNMLKitImageLabelingModule.kt`]: '1400baa74adc85bd317fe3d81b70ee319f7290dfb81e2671dbfbd34304e88886',
  [`${labels}/ios/RNMLKitImageLabelingModule.swift`]: 'ddecd5fe24600313759e9bfe5689332ddcd8c9f35c16ee4b28f77750396bc3f7',
  [`${faces}/ios/RNMLKitFaceDetectionModule.swift`]: '3c9bd1ce16c6dd88e67a0ca5befa315a37508edb0d3ee0bc0b016ff39e6169b1',
  [`${media}/android/src/main/java/expo/modules/medialibrary/assets/AssetUtils.kt`]: '5ef935070a2365429f58d9467a6559428a665a3a57dd997bc2e4b1fb5c062db8',
  [`${labels}/src/module/RNMLKitImageLabeler.ts`]: 'dfe93d2165957e441f20818d62c113bb3f0b6d3e94950260998355b8949e9424',
  [`${labels}/build/module/RNMLKitImageLabeler.js`]: '29e8fd0c18bbfb9de6de8624c7835a7c531181c653efc3661a271641ac7bca80',
  [`${labels}/src/hooks/useImageLabelingModels.ts`]: 'c341029e246564be23a2efa9597fcfd84cf6a6d0411e67ddd31c352d5d69b49c',
  [`${labels}/build/hooks/useImageLabelingModels.js`]: '9e0f8c50005fa2f66fda3bed621e18940717b2f7f6d1715bb9dbd29c0570fa27',
  [`${faces}/src/module/RNMLKitFaceDetector.ts`]: '7f268198a88e6259dfe9b2fd58cf123324ad15d2033f6dcbbeab51f136cc110e',
  [`${faces}/build/module/RNMLKitFaceDetector.js`]: '25858e38f1d4ad053753c2ac9d07752fb3b96c6cb3a10afe41a5e863ee536c8d',
};

function redact(source, patch) {
  let next = source.replace(/\r\n/g, '\n');
  for (const [before, after, expected = 1, optional = false] of patch.replacements) {
    const occurrences = next.split(before).length - 1;
    if (occurrences === 0 && (optional || next.includes(after))) continue;
    if (occurrences !== expected) throw new Error(`Privacy patch no longer matches ${patch.package}/${patch.file}`);
    next = next.split(before).join(after);
  }
  if (patch.package === faces && /console\.error\(\s*e(?:\s|\))/.test(next)) {
    throw new Error('Face detector privacy redaction is incomplete');
  }
  if (
    patch.file === 'ios/RNMLKitImageLabelingModule.swift'
    && (next.includes('\\(imagePath)') || next.includes('\\(spec.modelPath)'))
  ) {
    throw new Error('iOS image labeler privacy redaction is incomplete');
  }
  if (
    patch.file === 'ios/RNMLKitFaceDetectionModule.swift'
    && /logger\.debug\(\s*result\s*\)/.test(next)
  ) {
    throw new Error('iOS face detector privacy redaction is incomplete');
  }
  return next;
}

function applyPrivacyPatches(root, checkOnly = false) {
  for (const [name, expected] of Object.entries(versions)) {
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.version !== expected) throw new Error(`Review privacy patches before changing ${name}`);
  }
  // Validate all inputs before writing any dependency source. Unknown upstream
  // content fails installation instead of silently building without protection.
  const files = patches.map(patch => {
    const filename = path.join(root, 'node_modules', patch.package, patch.file);
    const before = fs.readFileSync(filename, 'utf8');
    const after = redact(before, patch);
    const fingerprint = createHash('sha256').update(after, 'utf8').digest('hex');
    if (fingerprint !== reviewedSources[`${patch.package}/${patch.file}`]) {
      throw new Error(`SDK source fingerprint mismatch: ${patch.package}/${patch.file}`);
    }
    if (checkOnly && before.replace(/\r\n/g, '\n') !== after) throw new Error('SDK privacy patches have not been applied');
    return { filename, before, after };
  });
  if (!checkOnly) for (const file of files) {
    if (file.before.replace(/\r\n/g, '\n') !== file.after) fs.writeFileSync(file.filename, file.after);
  }
  return files.length;
}

if (require.main === module) {
  try {
    const count = applyPrivacyPatches(path.resolve(__dirname, '..'), process.argv.includes('--check'));
    console.log(`SDK privacy log patches verified (${count} files).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { patches, versions, redact, applyPrivacyPatches };
