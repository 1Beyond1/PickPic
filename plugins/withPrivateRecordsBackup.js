const { withAndroidManifest, withDangerousMod, withAppDelegate, withProjectBuildGradle } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

const domains = ['root', 'file', 'database', 'sharedpref', 'external'];
const exclusions = domains.map(domain => `    <exclude domain="${domain}" path="." />`).join('\n');
module.exports = function withPrivateRecordsBackup(config) {
    config = withProjectBuildGradle(config, mod => {
        if (mod.modResults.language !== 'groovy') throw new Error('Encrypted SQLite integration expects the Expo Groovy project build file');
        const marker = '// PickPic: encrypted SQLite uses the application NDK';
        if (!mod.modResults.contents.includes(marker)) {
            // Expo SQLite enables CMake when SQLCipher is selected, but its
            // library default NDK can differ from the RN application toolchain.
            // Inherit the selected application version, never install/pin one.
            mod.modResults.contents += `\n${marker}\nsubprojects { library ->\n    if (library.name == 'expo-sqlite') {\n        library.plugins.withId('com.android.library') {\n            library.android.ndkVersion = rootProject.ext.ndkVersion\n        }\n    }\n}\n`;
        }
        return mod;
    });
    config = withAndroidManifest(config, mod => {
        const application = mod.modResults.manifest.application[0].$;
        application['android:allowBackup'] = 'false';
        application['android:fullBackupContent'] = '@xml/pickpic_backup_rules';
        application['android:dataExtractionRules'] = '@xml/pickpic_data_extraction_rules';

        // Restrict legacy external storage permissions to Android 12L (API 32)
        // and below; Android 13+ uses granular READ_MEDIA_IMAGES / VIDEO.
        const permissions = mod.modResults.manifest['uses-permission'];
        if (Array.isArray(permissions)) {
            for (const entry of permissions) {
                const name = entry?.$?.['android:name'];
                if (
                    name === 'android.permission.READ_EXTERNAL_STORAGE'
                    || name === 'android.permission.WRITE_EXTERNAL_STORAGE'
                ) {
                    entry.$['android:maxSdkVersion'] = '32';
                }
            }
        }
        return mod;
    });
    config = withDangerousMod(config, ['android', async mod => {
        const directory = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res/xml');
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'pickpic_backup_rules.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<full-backup-content>\n${exclusions}\n</full-backup-content>\n`);
        await fs.writeFile(path.join(directory, 'pickpic_data_extraction_rules.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>\n  <cloud-backup>\n${exclusions}\n  </cloud-backup>\n  <device-transfer>\n${exclusions}\n  </device-transfer>\n</data-extraction-rules>\n`);
        return mod;
    }]);
    return withAppDelegate(config, mod => {
        if (mod.modResults.language !== 'swift') throw new Error('Private records require a Swift AppDelegate');
        const marker = '// PickPic: exclude local records from automatic backups';
        if (!mod.modResults.contents.includes(marker)) {
            const anchor = 'return super.application(application, didFinishLaunchingWithOptions: launchOptions)';
            if (!mod.modResults.contents.includes(anchor)) throw new Error('Could not apply private records backup rules');
            const code = `${marker}\n    for directory in [FileManager.SearchPathDirectory.documentDirectory, .applicationSupportDirectory] {\n      if var url = FileManager.default.urls(for: directory, in: .userDomainMask).first {\n        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)\n        var values = URLResourceValues()\n        values.isExcludedFromBackup = true\n        try? url.setResourceValues(values)\n      }\n    }\n    `;
            mod.modResults.contents = mod.modResults.contents.replace(anchor, code + anchor);
        }
        return mod;
    });
};
