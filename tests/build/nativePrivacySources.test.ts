/** @jest-environment node */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

it('passes privacy-sensitive native modules through the actual Android autolinking resolver', () => {
    const root = path.resolve(__dirname, '../..');
    const linkerPackage = require.resolve('expo-modules-autolinking/package.json');
    const linker = JSON.parse(fs.readFileSync(linkerPackage, 'utf8'));
    const cli = path.resolve(path.dirname(linkerPackage), linker.bin['expo-modules-autolinking']);
    const resolved = JSON.parse(execFileSync(process.execPath, [cli, 'resolve', '--platform', 'android', '--json'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
    expect(resolved.configuration?.buildFromSource).toEqual(['expo-image', 'expo-media-library']);
    for (const name of ['expo-image', 'expo-media-library']) {
        const module = resolved.modules.find((item: any) => item.packageName === name);
        expect(module.projects.some((project: any) => project.name === name)).toBe(true);
    }
});
