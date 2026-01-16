import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// App version for announcement tracking
export const APP_VERSION = 'v0.3.1';

export type DisplayOrder = 'newest' | 'oldest' | 'random';

interface SettingsState {
    groupSize: 10 | 20 | 30;
    enableCollections: boolean;
    displayOrder: DisplayOrder;
    theme: 'WarmTerra' | 'light' | 'dark';
    language: 'zh' | 'en';
    activeCollectionIds: string[];
    selectedAlbumIds: string[]; // Empty = all albums

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
    setTheme: (theme: 'WarmTerra' | 'light' | 'dark') => void;
    setLanguage: (lang: 'zh' | 'en') => void;
    setSelectedAlbums: (ids: string[]) => void;
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
            theme: 'WarmTerra', // Default to Warm Terra theme
            language: 'zh',
            activeCollectionIds: [],
            selectedAlbumIds: [], // Empty = organize all albums
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
            onRehydrateStorage: () => (state) => {
                // Migration: convert legacy 'claude' and 'PPstyle' themes to 'WarmTerra'
                if (state && ((state.theme as any) === 'claude' || (state.theme as any) === 'PPstyle')) {
                    state.setTheme('WarmTerra');
                }
            },
        }
    )
);
