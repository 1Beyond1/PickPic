jest.mock('expo/config-plugins', () => ({
    withAndroidManifest: (config: any, callback: any) => { config.manifestMod = callback; return config; },
    withDangerousMod: (config: any, [_platform, callback]: any) => { config.filesMod = callback; return config; },
    withAppDelegate: (config: any, callback: any) => { config.delegateMod = callback; return config; },
    withProjectBuildGradle: (config: any, callback: any) => { config.projectMod = callback; return config; },
}));
jest.mock('node:fs/promises', () => ({ mkdir: jest.fn(), writeFile: jest.fn() }));
const fs = require('node:fs/promises');
const plugin = require('../../plugins/withPrivateRecordsBackup');

it('uses the application NDK for SQLCipher only, without pinning another toolchain', () => {
    const config = plugin({});
    const mod = { modResults: { language: 'groovy', contents: '// existing project configuration\n' } };
    config.projectMod(mod);
    const result = mod.modResults.contents;
    expect(result.startsWith('// existing project configuration')).toBe(true);
    expect(result).toContain("library.name == 'expo-sqlite'");
    expect(result).toContain('library.android.ndkVersion = rootProject.ext.ndkVersion');
    expect(result).not.toMatch(/27\.\d|ndkPath|sdkPath/);
    config.projectMod(mod); expect(mod.modResults.contents).toBe(result);
});

it('excludes private data from both Android cloud backup and device transfer without changing unrelated manifest fields', async () => {
    const config = plugin({});
    const application = { 'android:label': 'PickPic', 'android:allowBackup': 'true' };
    config.manifestMod({ modResults: { manifest: { application: [{ $: application }] } } });
    expect(application).toEqual(expect.objectContaining({
        'android:label': 'PickPic', 'android:allowBackup': 'false',
        'android:fullBackupContent': '@xml/pickpic_backup_rules',
        'android:dataExtractionRules': '@xml/pickpic_data_extraction_rules',
    }));

    const permissions = [
        { $: { 'android:name': 'android.permission.READ_EXTERNAL_STORAGE' } },
        { $: { 'android:name': 'android.permission.WRITE_EXTERNAL_STORAGE' } },
        { $: { 'android:name': 'android.permission.READ_MEDIA_IMAGES' } },
        { $: { 'android:name': 'android.permission.READ_MEDIA_VIDEO' } },
    ];
    config.manifestMod({ modResults: { manifest: { application: [{ $: { ...application } }], 'uses-permission': permissions } } });
    expect(permissions[0].$).toEqual({ 'android:name': 'android.permission.READ_EXTERNAL_STORAGE', 'android:maxSdkVersion': '32' });
    expect(permissions[1].$).toEqual({ 'android:name': 'android.permission.WRITE_EXTERNAL_STORAGE', 'android:maxSdkVersion': '32' });
    expect(permissions[2].$).toEqual({ 'android:name': 'android.permission.READ_MEDIA_IMAGES' });
    expect(permissions[3].$).toEqual({ 'android:name': 'android.permission.READ_MEDIA_VIDEO' });
    await config.filesMod({ modRequest: { platformProjectRoot: '/isolated/android' } });
    const outputs = jest.mocked(fs.writeFile).mock.calls;
    expect(outputs).toHaveLength(2);
    for (const [file, contents] of outputs) {
        expect(file).toMatch(/res[\\/]xml[\\/]pickpic_/);
        const sections = String(file).includes('data_extraction')
            ? [String(contents).split('<cloud-backup>')[1].split('</cloud-backup>')[0], String(contents).split('<device-transfer>')[1].split('</device-transfer>')[0]]
            : [String(contents)];
        for (const section of sections) for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) {
            expect(section).toContain(`<exclude domain="${domain}" path="." />`);
        }
    }
});

it('sets iOS directory backup exclusions before application launch once and retains existing Swift code', () => {
    const config = plugin({});
    const original = '// existing setup\nreturn super.application(application, didFinishLaunchingWithOptions: launchOptions)';
    const mod = { modResults: { language: 'swift', contents: original } };
    config.delegateMod(mod);
    const result = mod.modResults.contents;
    expect(result).toContain('// existing setup');
    expect(result).toContain('documentDirectory');
    expect(result).toContain('.applicationSupportDirectory');
    expect(result).toContain('values.isExcludedFromBackup = true');
    expect(result.indexOf('isExcludedFromBackup')).toBeLessThan(result.indexOf('return super.application'));
    config.delegateMod(mod);
    expect(mod.modResults.contents).toBe(result);
    expect(() => config.delegateMod({ modResults: { language: 'objc', contents: original } })).toThrow('Swift');
    expect(() => config.delegateMod({ modResults: { language: 'swift', contents: '// unsupported template' } })).toThrow('Could not apply');
});
