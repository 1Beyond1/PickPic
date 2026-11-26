const { withProjectBuildGradle } = require('expo/config-plugins');

const marker = '// PickPic: native crypto inherits the application build toolchain';
const snippet = `
${marker}
subprojects { nativeCryptoProject ->
    if (nativeCryptoProject.name in ['react-native-nitro-modules', 'react-native-quick-crypto']) {
        nativeCryptoProject.buildscript.configurations.configureEach { configuration ->
            configuration.resolutionStrategy.eachDependency { dependency ->
                def requested = dependency.requested
                if ((requested.group == 'com.android.tools.build' && requested.name == 'gradle') ||
                    (requested.group == 'org.jetbrains.kotlin' && requested.name == 'kotlin-gradle-plugin')) {
                    // The application classpath is already resolved when its root script runs.
                    // Standalone library defaults must not force an SDK/Gradle/JDK upgrade.
                    def applicationTool = rootProject.buildscript.configurations.classpath.resolvedConfiguration
                        .firstLevelModuleDependencies.find { tool ->
                            tool.moduleGroup == requested.group && tool.moduleName == requested.name
                        }
                    if (applicationTool == null) {
                        throw new GradleException('Missing application toolchain for native crypto')
                    }
                    dependency.useVersion(applicationTool.moduleVersion)
                }
            }
        }
    }
}
`;

function addNativeCryptoToolchain(contents) {
    if (contents.includes(marker)) return contents;
    return `${contents.trimEnd()}\n${snippet}`;
}

module.exports = function withNativeCryptoToolchain(config) {
    return withProjectBuildGradle(config, mod => {
        if (mod.modResults.language !== 'groovy') throw new Error('Native crypto integration expects the Expo Groovy project build file');
        mod.modResults.contents = addNativeCryptoToolchain(mod.modResults.contents);
        return mod;
    });
};
module.exports.addNativeCryptoToolchain = addNativeCryptoToolchain;
