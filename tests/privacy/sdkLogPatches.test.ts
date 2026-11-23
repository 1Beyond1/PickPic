/** @jest-environment node */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const { patches, versions, redact, applyPrivacyPatches } = require('../../scripts/apply-privacy-patches');

it('checks the actual installed SDK source and emitted JavaScript, not just the patch definitions', () => {
    expect(applyPrivacyPatches(path.resolve(__dirname, '../..'), true)).toBe(14);
});

it('redacts iOS ML Kit imagePath/modelPath and face detection result logs while keeping inference intact', () => {
    const labelPatch = patches.find((item: any) => item.file === 'ios/RNMLKitImageLabelingModule.swift');
    expect(labelPatch).toBeTruthy();
    const labelOriginal = 'logger.debug("RNMLKit", "addModel: Loading model \'\\(spec.modelName)\' from \\(spec.modelPath)")\n'
        + 'logger.info("RNMLKit", "classify image: Classifying image: \\(imagePath) ")\n'
        + 'let results = try await imageLabeler.classifyImage(imagePath: imagePath)';
    const labelNext = redact(labelOriginal, labelPatch);
    expect(labelNext).not.toContain('\\(imagePath)');
    expect(labelNext).not.toContain('\\(spec.modelPath)');
    expect(labelNext).toContain('try await imageLabeler.classifyImage(imagePath: imagePath)');
    expect(redact(labelNext, labelPatch)).toBe(labelNext);

    const facePatch = patches.find((item: any) => item.file === 'ios/RNMLKitFaceDetectionModule.swift');
    expect(facePatch).toBeTruthy();
    const faceOriginal = 'let result = try await faceDetector.detectFaces(image: image)\n'
        + 'logger.debug(result)\n'
        + 'promise.resolve(result.record)';
    const faceNext = redact(faceOriginal, facePatch);
    expect(faceNext).not.toContain('logger.debug(result)');
    expect(faceNext).toContain('promise.resolve(result.record)');
    expect(redact(faceNext, facePatch)).toBe(faceNext);
});

it('keeps native image loading and rejected errors intact while removing URI logging', () => {
    const patch = patches.find((item: any) => item.file.endsWith('RNMLKitImage.kt'));
    const original = 'Log.d("RNMLKit", "RNMLKitImage: Loading Image from $_imagePath")\n'
        + '_image = InputImage.fromFilePath(context, _imagePath)\n'
        + 'throw Exception("RNMLKitImage: Could not load image from $_imagePath", e)';
    const next = redact(original, patch);
    expect(next).not.toContain('Log.d("RNMLKit", "RNMLKitImage: Loading Image from');
    expect(next).toContain('_image = InputImage.fromFilePath(context, _imagePath)');
    expect(next).toContain('throw Exception("RNMLKitImage: Could not load image from $_imagePath", e)');
    expect(redact(next, patch)).toBe(next);
});

it('rejects an unexpected source rather than marking the privacy patch applied', () => {
    const patch = patches.find((item: any) => item.file.endsWith('RNMLKitImage.kt'));
    expect(() => redact('Log.d("RNMLKit", "new upstream path format")', patch)).toThrow('no longer matches');
});

it('checks package versions before touching any source file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pickpic-sdk-patch-test-'));
    try {
        const [name] = Object.keys(versions);
        const packageDirectory = path.join(directory, 'node_modules', name);
        fs.mkdirSync(packageDirectory, { recursive: true });
        fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ version: '0.0.0' }));
        expect(() => applyPrivacyPatches(directory)).toThrow('Review privacy patches');
        expect(fs.readdirSync(packageDirectory)).toEqual(['package.json']);
    } finally {
        // Exact temporary fixture created by this test, never the workspace.
        fs.rmSync(directory, { recursive: true });
    }
});

it('rejects changed SDK content outside the log anchors before writing any file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pickpic-sdk-content-test-'));
    const project = path.resolve(__dirname, '../..');
    try {
        for (const [name, version] of Object.entries(versions)) {
            const packageDirectory = path.join(directory, 'node_modules', name);
            fs.mkdirSync(packageDirectory, { recursive: true });
            fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ version }));
        }
        for (const patch of patches) {
            const relative = path.join('node_modules', patch.package, patch.file);
            const target = path.join(directory, relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(project, relative), target);
        }
        const first = patches[0];
        const firstFile = path.join(directory, 'node_modules', first.package, first.file);
        const installed = fs.readFileSync(firstFile, 'utf8');
        const [before, after] = first.replacements[0];
        const unpatched = installed.replace(after, before);
        fs.writeFileSync(firstFile, unpatched);
        const last = patches[patches.length - 1];
        const changedFile = path.join(directory, 'node_modules', last.package, last.file);
        fs.appendFileSync(changedFile, '\n// Unexpected upstream change outside redaction anchors.\n');

        expect(() => applyPrivacyPatches(directory)).toThrow('SDK source fingerprint mismatch');
        expect(fs.readFileSync(firstFile, 'utf8')).toBe(unpatched);
        expect(() => applyPrivacyPatches(directory, true)).toThrow();
    } finally {
        // Only the exact fixture allocated above, never SDK/workspace files.
        fs.rmSync(directory, { recursive: true });
    }
});
