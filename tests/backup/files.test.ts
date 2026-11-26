jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: jest.fn().mockResolvedValue(new Uint8Array(8)) }));
jest.mock('expo-file-system/legacy', () => ({
    StorageAccessFramework: { requestDirectoryPermissionsAsync: jest.fn(), createFileAsync: jest.fn() },
    readAsStringAsync: jest.fn(), writeAsStringAsync: jest.fn(), deleteAsync: jest.fn(), EncodingType: { Base64: 'base64' },
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('react-native-quick-base64', () => ({
    toByteArray: (value: string) => new Uint8Array(Buffer.from(value, 'base64')),
}));
const mockCreate = jest.fn(); const mockWrite = jest.fn(); const mockDelete = jest.fn(); const mockRead = jest.fn();
let mockSize = 65536; let mockExists = true; let mockThrowOnRead = false;
jest.mock('expo-file-system', () => ({
    Paths: { cache: { uri: 'file:///app/cache/' } },
    File: class {
        uri: string;
        constructor(...parts: any[]) { this.uri = parts.map(part => typeof part === 'string' ? part : part.uri).join(''); }
        get exists() {
            if (mockThrowOnRead) throw new Error('Unsupported content URI');
            return mockExists;
        }
        get size() { return mockSize; }
        create = mockCreate; write = mockWrite; delete = mockDelete; bytes = mockRead;
    },
}));
import { Platform } from 'react-native';
import * as Picker from 'expo-document-picker';
import * as Legacy from 'expo-file-system/legacy';
import { MAX_BACKUP_BYTES } from '../../services/backup/crypto';
import { pickEncryptedFile, saveEncryptedFile } from '../../services/backup/files';
beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockSize = 65536; mockExists = true; mockThrowOnRead = false;
    jest.mocked(Legacy.StorageAccessFramework.requestDirectoryPermissionsAsync).mockResolvedValue({ granted: true, directoryUri: 'content://chosen' });
    jest.mocked(Legacy.StorageAccessFramework.createFileAsync).mockResolvedValue('content://chosen/backup');
    jest.mocked(Legacy.readAsStringAsync).mockResolvedValue('ciphertext-base64');
    jest.mocked(Legacy.writeAsStringAsync).mockResolvedValue(undefined);
});
it('writes only the supplied ciphertext and removes its own encrypted cache file', async () => {
    const ciphertext = new Uint8Array([80, 75, 80, 73]);
    await expect(saveEncryptedFile(ciphertext)).resolves.toBe(true);
    expect(mockWrite).toHaveBeenCalledWith(ciphertext);
    expect(Legacy.writeAsStringAsync).toHaveBeenCalledWith('content://chosen/backup', 'ciphertext-base64', { encoding: 'base64' });
    expect(mockDelete).toHaveBeenCalledTimes(1);
});
it('does not create a destination if the user cancels the directory picker', async () => {
    jest.mocked(Legacy.StorageAccessFramework.requestDirectoryPermissionsAsync).mockResolvedValue({ granted: false } as any);
    await expect(saveEncryptedFile(new Uint8Array(100))).resolves.toBe(false);
    expect(Legacy.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledTimes(1);
});
it('checks input size before reading and never removes the original user file', async () => {
    jest.mocked(Picker.getDocumentAsync).mockResolvedValue({ canceled: false, assets: [{ uri: 'content://original/backup' }] } as any);
    mockSize = MAX_BACKUP_BYTES + 1;
    await expect(pickEncryptedFile()).rejects.toMatchObject({ code: 'size' });
    expect(Picker.getDocumentAsync).toHaveBeenCalledWith({ type: '*/*', copyToCacheDirectory: false, multiple: false });
    expect(mockRead).not.toHaveBeenCalled(); expect(mockDelete).not.toHaveBeenCalled();
});
it('rejects oversized asset.size immediately without copying to cache or reading bytes', async () => {
    jest.mocked(Picker.getDocumentAsync).mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'content://media/external/video/999', size: MAX_BACKUP_BYTES + 1024 }],
    } as any);
    await expect(pickEncryptedFile()).rejects.toMatchObject({ code: 'size' });
    expect(Picker.getDocumentAsync).toHaveBeenCalledWith({ type: '*/*', copyToCacheDirectory: false, multiple: false });
    expect(mockRead).not.toHaveBeenCalled();
    expect(Legacy.readAsStringAsync).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
});
it('falls back safely to bounded Android content:// base64 read when File cannot inspect non-SAF URI', async () => {
    const expected = new Uint8Array([80, 75, 80, 73, 67]);
    mockExists = false;
    jest.mocked(Picker.getDocumentAsync).mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'content://thirdparty.provider/backup.pickpic', size: expected.length }],
    } as any);
    jest.mocked(Legacy.readAsStringAsync).mockResolvedValue(Buffer.from(expected).toString('base64'));
    await expect(pickEncryptedFile()).resolves.toEqual(expected);
    expect(Legacy.readAsStringAsync).toHaveBeenCalledWith('content://thirdparty.provider/backup.pickpic', { encoding: 'base64' });
    expect(mockDelete).not.toHaveBeenCalled();
});
it('refuses unbounded Android content:// fallback when asset.size is missing and File cannot verify size', async () => {
    mockThrowOnRead = true;
    jest.mocked(Picker.getDocumentAsync).mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'content://thirdparty.provider/unknown-size' }],
    } as any);
    await expect(pickEncryptedFile()).rejects.toMatchObject({ code: 'unavailable' });
    expect(Legacy.readAsStringAsync).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
});
it('throws unavailable (not size) when a non-Android-content file does not exist', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mockExists = false;
    jest.mocked(Picker.getDocumentAsync).mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'file:///missing/backup.pickpic', size: 128 }],
    } as any);
    await expect(pickEncryptedFile()).rejects.toMatchObject({ code: 'unavailable' });
    expect(mockRead).not.toHaveBeenCalled();
    expect(Legacy.readAsStringAsync).not.toHaveBeenCalled();
});
it('removes only the private picker copy after reading', async () => {
    jest.mocked(Picker.getDocumentAsync).mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///app/cache/DocumentPicker/backup' }] } as any);
    const bytes = new Uint8Array([1, 2]); mockRead.mockResolvedValue(bytes);
    await expect(pickEncryptedFile()).resolves.toBe(bytes);
    expect(mockDelete).toHaveBeenCalledTimes(1);
});
