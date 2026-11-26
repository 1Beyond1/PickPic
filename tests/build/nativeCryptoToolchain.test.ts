jest.mock('expo/config-plugins', () => ({ withProjectBuildGradle: (_config: any, action: any) => action(_config) }));
const plugin = require('../../plugins/withNativeCryptoToolchain');

it('preserves existing project configuration and appends only targeted inheritance once', () => {
    const original = "// user configuration\nbuildscript { dependencies { classpath('com.android.tools.build:gradle') } }\n";
    const output = plugin.addNativeCryptoToolchain(original);
    expect(output.startsWith(original)).toBe(true);
    expect(output).toContain("['react-native-nitro-modules', 'react-native-quick-crypto']");
    expect(output).toContain('dependency.useVersion(applicationTool.moduleVersion)');
    expect(output).not.toMatch(/gradle:9|gradle:8|kotlin-gradle-plugin:\d/);
    expect(plugin.addNativeCryptoToolchain(output)).toBe(output);
});
it('applies the Expo project mod but rejects unsupported DSL instead of corrupting it', () => {
    const config = { modResults: { language: 'groovy', contents: '// existing\n' } };
    expect(plugin(config)).toBe(config);
    expect(config.modResults.contents).toContain('// existing');
    expect(() => plugin({ modResults: { language: 'kotlin', contents: '// untouched' } })).toThrow('Groovy');
});
