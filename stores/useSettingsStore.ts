import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// App version for announcement tracking
export const APP_VERSION = 'v0.1.1';

interface SettingsState {
    groupSize: 10 | 20 | 30;
    enableCollections: boolean;
    enableRandomDisplay: boolean;
    theme: 'light' | 'dark' | 'auto';
    language: 'zh' | 'en';
    activeCollectionIds: string[];

    // Announcement tracking
    dismissedAnnouncementVersion: string | null;

    // Actions
    setGroupSize: (size: 10 | 20 | 30) => void;
    toggleCollections: () => void;
    setActiveCollections: (ids: string[]) => void;
    toggleRandomDisplay: () => void;
    setTheme: (theme: 'light' | 'dark' | 'auto') => void;
    setLanguage: (lang: 'zh' | 'en') => void;
    dismissAnnouncement: (version: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set) => ({
            groupSize: 10,
            enableCollections: false, // Hidden for v0.1.1
            enableRandomDisplay: true, // Default ON
            theme: 'light', // Default to Light per user request
            language: 'zh',
            activeCollectionIds: [],
            dismissedAnnouncementVersion: null,

            setGroupSize: (size) => set({ groupSize: size }),
            toggleCollections: () => set((state) => ({ enableCollections: !state.enableCollections })),
            setActiveCollections: (ids) => set({ activeCollectionIds: ids }),
            toggleRandomDisplay: () => set((state) => ({ enableRandomDisplay: !state.enableRandomDisplay })),
            setTheme: (theme) => set({ theme }),
            setLanguage: (lang) => set({ language: lang }),
            dismissAnnouncement: (version) => set({ dismissedAnnouncementVersion: version }),
        }),
        {
            name: 'photoapp-settings',
            storage: createJSONStorage(() => AsyncStorage),
        }
    )
);
