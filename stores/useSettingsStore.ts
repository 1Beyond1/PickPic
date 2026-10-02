import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// App version for announcement tracking
export const APP_VERSION = 'v0.4.0';

export type DisplayOrder = 'newest' | 'oldest' | 'random';
export type ThemeSetting = 'light' | 'dark';

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

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set) => ({
            groupSize: 10,
            enableCollections: false,
            displayOrder: 'random', // Default to random (was enableRandomDisplay: true)
            theme: 'light',
            language: 'zh',
            activeCollectionIds: [],
            selectedAlbumIds: [], // Empty = organize all albums
            hasHydrated: false,
            dismissedAnnouncementVersion: null,

            // Developer options (default off)
            showDevOptions: false,
            enableAIClassification: false, // Default: OFF for faster scanning

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

            // AI Guide and Prompts
            aiGuideShownVersion: null,
            aiScanPromptDismissedVersion: null,
            dismissAIGuide: (version) => set({ aiGuideShownVersion: version }),
            dismissAIScanPrompt: (version) => set({ aiScanPromptDismissedVersion: version }),
        }),
        {
            name: 'photoapp-settings',
            storage: createJSONStorage(() => AsyncStorage),
            onRehydrateStorage: () => (state, error) => {
                // Older releases persisted WarmTerra, claude and PPstyle.
                // Preserve every other setting while mapping those modes to
                // the new neutral light appearance.
                if (state && state.theme !== 'light' && state.theme !== 'dark') {
                    state.setTheme('light');
                }
                // Zustand passes undefined when storage read/parse fails. The
                // app can safely continue with defaults, but must still leave
                // the hydration gate or media screens would never load.
                if (error && typeof window !== 'undefined') {
                    console.error('[SettingsStore] Failed to rehydrate settings:', error);
                }
                // AsyncStorage's web adapter cannot access window during Expo's
                // server-side/static render. There is no client store to open
                // there, so avoid calling a persisted setter in that phase.
                if (!state && typeof window === 'undefined') return;
                (state ?? useSettingsStore.getState()).setHasHydrated(true);
            },
        }
    )
);
