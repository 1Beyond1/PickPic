jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSettingsStore } from '../stores/useSettingsStore';

const getItem = AsyncStorage.getItem as jest.Mock;

describe('persisted theme compatibility', () => {
  beforeEach(() => {
    getItem.mockReset();
  });

  it.each(['WarmTerra', 'claude', 'PPstyle'])(
    'maps legacy %s to light without losing other preferences',
    async oldTheme => {
      getItem.mockResolvedValue(JSON.stringify({
        state: {
          theme: oldTheme,
          language: 'en',
          groupSize: 20,
          displayOrder: 'oldest',
          selectedAlbumIds: ['album-42'],
          dismissedAnnouncementVersion: 'v0.3.1',
        },
        version: 0,
      }));

      await useSettingsStore.persist.rehydrate();

      const state = useSettingsStore.getState();
      expect(state.hasHydrated).toBe(true);
      expect(state.theme).toBe('light');
      expect(state.language).toBe('en');
      expect(state.groupSize).toBe(20);
      expect(state.displayOrder).toBe('oldest');
      expect(state.selectedAlbumIds).toEqual(['album-42']);
      expect(state.dismissedAnnouncementVersion).toBe('v0.3.1');
    },
  );

  it('preserves a stored dark theme', async () => {
    getItem.mockResolvedValue(JSON.stringify({
      state: { theme: 'dark', selectedAlbumIds: ['album-42'] },
      version: 0,
    }));

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(useSettingsStore.getState().selectedAlbumIds).toEqual(['album-42']);
  });
});
