import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';
const mockReplace = jest.fn();
const mockGetPermission = jest.fn();
const mockRefresh = jest.fn().mockResolvedValue(undefined);
let mockMediaHydrated = false, mockSettingsHydrated = false;
let mockFailures: Record<string, string> = {};
jest.mock('expo-router', () => ({
    useRouter: () => ({ replace: mockReplace }), usePathname: () => '/videos',
    Stack: Object.assign(({ children }: any) => <>{children}</>, { Screen: () => null }),
}));
jest.mock('expo-media-library', () => ({
    usePermissions: () => [{ granted: false }, null, mockGetPermission],
    addListener: () => ({ remove: jest.fn() }),
}));
jest.mock('expo-splash-screen', () => ({ preventAutoHideAsync: async () => {}, hideAsync: async () => {} }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: ({ children }: any) => <>{children}</> }));
jest.mock('../../hooks/useThemeColor', () => ({ useThemeColor: () => ({ isDark: false, colors: { background: '#fff' } }) }));
jest.mock('../../components/PrivacyRecoveryScreen', () => ({ PrivacyRecoveryScreen: () => <></> }));
jest.mock('../../components/AIScanGuideModal', () => ({ AIScanGuideModal: () => null }));
jest.mock('../../components/AnnouncementModal', () => ({ AnnouncementModal: () => null }));
jest.mock('../../components/MLBridge', () => ({ MLBridge: () => null }));
jest.mock('../../services/scanner', () => ({ isScanning: () => false, start: jest.fn(), stop: jest.fn() }));
jest.mock('../../services/mediaProgressStorage', () => ({ flushMediaProgress: async () => {} }));
jest.mock('../../services/privacy/settingsStorage', () => ({ flushSettings: async () => {} }));
jest.mock('../../services/privacy/mediaCache', () => ({ clearLegacyMediaCache: async () => {} }));
jest.mock('../../stores/useScannerStore', () => ({ useScannerStore: { getState: () => ({ setLastError: jest.fn() }) } }));
jest.mock('../../database', () => ({ AssetRepository: {}, getDatabase: async () => ({}), closeDatabase: async () => {} }));
jest.mock('../../stores/usePrivacyStore', () => ({
    usePrivacyStore: Object.assign((selector: any) => selector({ failures: mockFailures }), { getState: () => ({ failures: mockFailures }) }),
}));
jest.mock('../../stores/useSettingsStore', () => ({
    APP_VERSION: 'v0.4.0',
    useSettingsStore: Object.assign(() => ({ hasHydrated: mockSettingsHydrated, enableAIClassification: false }), { getState: () => ({}) }),
}));
jest.mock('../../stores/useMediaStore', () => ({
    useMediaStore: Object.assign((selector: any) => selector({ hasHydrated: mockMediaHydrated }), { getState: () => ({
        refreshTotalCounts: mockRefresh, setPermissionScope: jest.fn(), refreshQueuedAssetVisibility: jest.fn(), pruneUnavailableQueuedAssets: jest.fn(),
    }) }),
}));
import RootLayout from '../../app/_layout';
beforeEach(() => {
    mockMediaHydrated = false; mockSettingsHydrated = false; mockFailures = {};
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
