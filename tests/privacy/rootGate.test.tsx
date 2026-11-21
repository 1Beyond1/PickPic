import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';
const mockReplace = jest.fn();
const mockGetPermission = jest.fn();
const mockRefresh = jest.fn().mockResolvedValue(undefined);
const mockClearLoadedMedia = jest.fn();
const mockNotifyMediaLibraryRefresh = jest.fn();
const mockNotifyPermissionRefresh = jest.fn();
const mockLoadAlbums = jest.fn().mockResolvedValue(undefined);
const mockLoadPhotos = jest.fn().mockResolvedValue(undefined);
const mockRemoveDeletedAssets = jest.fn();
const mockStopScanner = jest.fn();
let mockIsScanning = false;
let mockMediaPermissionResponse: { granted: boolean; accessPrivileges?: string } = { granted: false };
let mockMediaLibraryListener: ((event: any) => void) | null = null;
let mockMediaHydrated = false, mockSettingsHydrated = false;
let mockFailures: Record<string, string> = {};
jest.mock('expo-router', () => ({
    useRouter: () => ({ replace: mockReplace }), usePathname: () => '/videos',
    Stack: Object.assign(({ children }: any) => <>{children}</>, { Screen: () => null }),
}));
jest.mock('expo-media-library', () => ({
    usePermissions: () => [mockMediaPermissionResponse, null, mockGetPermission],
    addListener: (listener: (event: any) => void) => {
        mockMediaLibraryListener = listener;
        return { remove: jest.fn() };
    },
}));
jest.mock('expo-splash-screen', () => ({ preventAutoHideAsync: async () => {}, hideAsync: async () => {} }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: ({ children }: any) => <>{children}</> }));
jest.mock('../../hooks/useThemeColor', () => ({ useThemeColor: () => ({ isDark: false, colors: { background: '#fff' } }) }));
jest.mock('../../components/PrivacyRecoveryScreen', () => ({ PrivacyRecoveryScreen: () => <></> }));
jest.mock('../../components/AIScanGuideModal', () => ({ AIScanGuideModal: () => null }));
jest.mock('../../components/AnnouncementModal', () => ({ AnnouncementModal: () => null }));
jest.mock('../../components/MLBridge', () => ({ MLBridge: () => null }));
jest.mock('../../services/scanner', () => ({
    isScanning: () => mockIsScanning,
    start: jest.fn(),
    stop: (...args: any[]) => mockStopScanner(...args),
}));
jest.mock('../../services/mediaProgressStorage', () => ({ flushMediaProgress: async () => {} }));
jest.mock('../../services/privacy/settingsStorage', () => ({ flushSettings: async () => {} }));
jest.mock('../../services/privacy/mediaCache', () => ({ clearLegacyMediaCache: async () => {} }));
jest.mock('../../stores/useScannerStore', () => ({ useScannerStore: { getState: () => ({ setLastError: jest.fn() }) } }));
jest.mock('../../database', () => ({
    AssetRepository: { removeAssetsAndDerivedData: jest.fn().mockResolvedValue(undefined) },
    getDatabase: async () => ({}),
    closeDatabase: async () => {},
}));
jest.mock('../../stores/usePrivacyStore', () => ({
    usePrivacyStore: Object.assign((selector: any) => selector({ failures: mockFailures }), { getState: () => ({ failures: mockFailures }) }),
}));
jest.mock('../../stores/useSettingsStore', () => ({
    APP_VERSION: 'v0.4.0',
    useSettingsStore: Object.assign(() => ({ hasHydrated: mockSettingsHydrated, enableAIClassification: false }), {
        getState: () => ({ groupSize: 10, displayOrder: 'random', selectedAlbumIds: [] }),
    }),
}));
jest.mock('../../stores/useMediaStore', () => ({
    useMediaStore: Object.assign((selector: any) => selector({ hasHydrated: mockMediaHydrated }), { getState: () => ({
        refreshTotalCounts: mockRefresh,
        setPermissionScope: jest.fn(),
        refreshQueuedAssetVisibility: jest.fn(),
        pruneUnavailableQueuedAssets: jest.fn(),
        clearLoadedMedia: mockClearLoadedMedia,
        notifyMediaLibraryRefresh: mockNotifyMediaLibraryRefresh,
        notifyPermissionRefresh: mockNotifyPermissionRefresh,
        loadAlbums: mockLoadAlbums,
        loadPhotos: mockLoadPhotos,
        removeDeletedAssets: mockRemoveDeletedAssets,
        organizingSessions: { photo: null, video: null },
    }) }),
}));
import RootLayout from '../../app/_layout';
beforeEach(() => {
    jest.clearAllMocks();
    mockMediaHydrated = false; mockSettingsHydrated = false; mockFailures = {};
    mockIsScanning = false;
    mockMediaPermissionResponse = { granted: false };
    mockMediaLibraryListener = null;
    mockGetPermission.mockResolvedValue({ granted: false });
});

it('does not navigate before routes mount or while records fail to open, then restores the permission gate', async () => {
    const screen = render(<RootLayout />);
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(mockGetPermission).not.toHaveBeenCalled(); expect(mockReplace).not.toHaveBeenCalled();
    mockSettingsHydrated = true; mockMediaHydrated = true; mockFailures = { records: 'read' };
    screen.rerender(<RootLayout />);
    await act(async () => { await Promise.resolve(); });
    expect(mockGetPermission).not.toHaveBeenCalled(); expect(mockReplace).not.toHaveBeenCalled();
    mockFailures = {};
    screen.rerender(<RootLayout />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
});

it('debounces incremental gallery changes without clearing loaded feeds or stopping an active AI scan, while scope changes react immediately', async () => {
    jest.useFakeTimers();
    try {
        mockMediaHydrated = true;
        mockSettingsHydrated = true;
        mockIsScanning = true;
        mockMediaPermissionResponse = { granted: true, accessPrivileges: 'all' };
        mockGetPermission.mockResolvedValue({ granted: true, accessPrivileges: 'all' });

        render(<RootLayout />);
        await waitFor(() => expect(mockMediaLibraryListener).not.toBeNull());
        mockClearLoadedMedia.mockClear();
        mockStopScanner.mockClear();
        mockNotifyMediaLibraryRefresh.mockClear();

        // Two rapid incremental media events must not clear loaded videos or stop scanning.
        act(() => {
            mockMediaLibraryListener!({ hasIncrementalChanges: true, insertedAssets: [{ id: 'new-1' }] });
            mockMediaLibraryListener!({ hasIncrementalChanges: true, insertedAssets: [{ id: 'new-2' }] });
        });
        expect(mockClearLoadedMedia).not.toHaveBeenCalled();
        expect(mockStopScanner).not.toHaveBeenCalled();
        expect(mockNotifyMediaLibraryRefresh).not.toHaveBeenCalled();

        act(() => { jest.advanceTimersByTime(300); });
        expect(mockNotifyMediaLibraryRefresh).toHaveBeenCalledTimes(1);
        expect(mockClearLoadedMedia).not.toHaveBeenCalled();
        expect(mockStopScanner).not.toHaveBeenCalled();

        // A permission-scope change still clears loaded media and stops scanning immediately.
        act(() => {
            mockMediaLibraryListener!({ hasIncrementalChanges: false });
        });
        expect(mockClearLoadedMedia).toHaveBeenCalledTimes(1);
        expect(mockStopScanner).toHaveBeenCalledTimes(1);
        expect(mockNotifyPermissionRefresh).toHaveBeenCalledTimes(1);
    } finally {
        jest.useRealTimers();
    }
});
