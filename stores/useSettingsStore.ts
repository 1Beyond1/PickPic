import { settingsStorage } from '../services/privacy/settingsStorage';
import { markEncryptedStorageHydrated } from '../services/privacy/encryptedStorage';
import { mergeProtectedState } from '../services/privacy/mergeState';
import { usePrivacyStore } from './usePrivacyStore';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// App version for announcement tracking
export const APP_VERSION = 'v0.5.1';

export type DisplayOrder = 'newest' | 'oldest' | 'random';
export type ThemeSetting = 'light' | 'dark' | 'system';

interface SettingsState {
    groupSize: 10 | 20 | 30;
    enableCollections: boolean;
    displayOrder: DisplayOrder;
    theme: ThemeSetting;
    language: 'zh' | 'en';
    activeCollectionIds: string[];
    selectedAlbumIds: string[]; // Empty = all albums
    hasHydrated: boolean;

    // Announcement tracking
    dismissedAnnouncementVersion: string | null;

    // Developer options
    showDevOptions: boolean;
    enableAIClassification: boolean; // AI image labeling (slower scan)

    // Actions
    setGroupSize: (size: 10 | 20 | 30) => void;
    toggleCollections: () => void;
    setActiveCollections: (ids: string[]) => void;
    setDisplayOrder: (order: DisplayOrder) => void;
    setTheme: (theme: ThemeSetting) => void;
    setLanguage: (lang: 'zh' | 'en') => void;
    setSelectedAlbums: (ids: string[]) => void;
    setHasHydrated: (hasHydrated: boolean) => void;
    dismissAnnouncement: (version: string) => void;
    toggleDevOptions: () => void;
    setEnableAIClassification: (enabled: boolean) => void;

    // AI Guide and Prompts
    aiGuideShownVersion: string | null;
    aiScanPromptDismissedVersion: string | null;
    dismissAIGuide: (version: string) => void;
    dismissAIScanPrompt: (version: string) => void;

}

export const DEFAULT_SETTINGS_STATE = {
    groupSize: 10 as 10 | 20 | 30,
    enableCollections: false,
    displayOrder: 'random' as DisplayOrder,
    theme: 'light' as ThemeSetting,
    language: 'zh' as 'zh' | 'en',
    activeCollectionIds: [] as string[],
    selectedAlbumIds: [] as string[],
    hasHydrated: false,
    dismissedAnnouncementVersion: null as string | null,
    showDevOptions: false,
    enableAIClassification: false,
    aiGuideShownVersion: null as string | null,
    aiScanPromptDismissedVersion: null as string | null,
};

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set) => ({
            ...DEFAULT_SETTINGS_STATE,

            setGroupSize: (size) => set({ groupSize: size }),
            toggleCollections: () => set((state) => ({ enableCollections: !state.enableCollections })),
            setActiveCollections: (ids) => set({ activeCollectionIds: ids }),
            setDisplayOrder: (order) => set({ displayOrder: order }),
            setTheme: (theme) => set({ theme }),
            setLanguage: (lang) => set({ language: lang }),
            setSelectedAlbums: (ids) => set({ selectedAlbumIds: ids }),
            setHasHydrated: (hasHydrated) => set({ hasHydrated }),
            dismissAnnouncement: (version) => set({ dismissedAnnouncementVersion: version }),
            toggleDevOptions: () => set((state) => ({ showDevOptions: !state.showDevOptions })),
            setEnableAIClassification: (enabled) => set({ enableAIClassification: enabled }),

            dismissAIGuide: (version) => set({ aiGuideShownVersion: version }),
            dismissAIScanPrompt: (version) => set({ aiScanPromptDismissedVersion: version }),
        }),
        {
            name: 'photoapp-settings',
            storage: createJSONStorage(() => settingsStorage),
            merge: mergeProtectedState,
            onRehydrateStorage: () => (state, error) => {
                if (error) { usePrivacyStore.getState().block('settings', 'read'); return; }
                if (!state) return;
                markEncryptedStorageHydrated('settings', 'photoapp-settings');
                // Older releases persisted WarmTerra, claude and PPstyle.
                // Preserve every other setting while mapping those modes to
                // the new neutral light appearance.
                if (state.theme !== 'light' && state.theme !== 'dark' && state.theme !== 'system') {
                    state.setTheme('light');
                }
                state.setHasHydrated(true);
            },
        }
    )
);
