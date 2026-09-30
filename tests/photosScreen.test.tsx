import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockLoadPhotos = jest.fn().mockResolvedValue(undefined);
const mockLoadAlbums = jest.fn().mockResolvedValue(undefined);
const mockPhoto = (id: string) => ({ id, uri: `file:///${id}.jpg`, filename: `${id}.jpg`, creationTime: 1 });
const mockMediaState = {
  photos: [mockPhoto('one'), mockPhoto('two'), mockPhoto('three')],
  albums: [],
  loadPhotos: mockLoadPhotos,
  loadAlbums: mockLoadAlbums,
  isLoading: false,
  hasHydrated: true,
  photoProcessedIds: [] as string[],
  markForDeletion: jest.fn(),
  markAsSkipped: jest.fn(),
  confirmDeletion: jest.fn(),
  deleteQueue: [] as ReturnType<typeof mockPhoto>[],
  resetBatch: jest.fn(),
  isConfirmingDeletion: false,
  createAlbum: jest.fn(),
  addAssetToAlbum: jest.fn(),
  permissionScope: 'full',
  hiddenPhotoQueuedAssetIds: null,
  mediaLibraryRefreshVersion: 0,
};
const mockSettingsState = {
  groupSize: 10,
  displayOrder: 'random',
  selectedAlbumIds: [],
  setSelectedAlbums: jest.fn(),
  hasHydrated: true,
};

jest.mock('expo-media-library', () => ({
  getPermissionsAsync: jest.fn(),
  presentPermissionsPickerAsync: jest.fn(),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: (effect: () => void) => {
    const ReactModule = require('react');
    ReactModule.useEffect(effect, [effect]);
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../components/AlbumSelector', () => ({ AlbumSelector: () => null }));
jest.mock('../components/GlassContainer', () => ({ GlassContainer: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../components/PhotoCard', () => ({
  PhotoCard: ({ photo }: { photo: { id: string } }) => {
    const ReactModule = require('react');
    const { Text } = require('react-native');
    return ReactModule.createElement(Text, null, `card:${photo.id}`);
  },
}));
jest.mock('../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../hooks/useThemeColor', () => ({
  useThemeColor: () => ({
    isDark: true,
    colors: {
      background: '#111212', text: '#F1F2EF', textSecondary: '#B1B8B0',
      surface: '#1D1E1E', surfaceHover: '#232524', divider: '#2B2D2B',
      actionBackground: '#EFF2ED', actionForeground: '#181B18',
      danger: '#EAB0A4', dangerBackground: '#A7483F', dangerForeground: '#FFFFFF',
    },
  }),
}));
jest.mock('../stores/useMediaStore', () => ({
  useMediaStore: Object.assign(() => mockMediaState, { getState: () => mockMediaState }),
}));
jest.mock('../stores/useSettingsStore', () => ({ useSettingsStore: () => mockSettingsState }));

import PhotosScreen from '../app/(tabs)/photos';

describe('PhotosScreen visual entry', () => {
  beforeEach(() => {
    mockMediaState.photos = [mockPhoto('one'), mockPhoto('two'), mockPhoto('three')];
    mockMediaState.photoProcessedIds = [];
    mockMediaState.deleteQueue = [];
    mockMediaState.permissionScope = 'full';
    jest.clearAllMocks();
  });

  it('shows the real current batch count, then opens the existing photo deck', () => {
    mockMediaState.photos = [mockPhoto('one'), mockPhoto('two')];
    render(<PhotosScreen />);
    expect(screen.getAllByText('2')).toHaveLength(2);
    fireEvent.press(screen.getByText('photos_home_start'));
    expect(screen.getByText('card:one')).toBeTruthy();
  });

  it('keeps the deck open as an in-memory batch is processed', () => {
    const view = render(<PhotosScreen />);
    fireEvent.press(screen.getByText('photos_home_start'));
    mockMediaState.photoProcessedIds = ['one'];
    view.rerender(<PhotosScreen />);
    expect(screen.queryByText('photos_home_start')).toBeNull();
    expect(screen.getByText('card:two')).toBeTruthy();
  });

  it('keeps the deletion review reachable when the batch is finished', () => {
    mockMediaState.photoProcessedIds = ['one', 'two', 'three'];
    mockMediaState.deleteQueue = [mockPhoto('one')];
    render(<PhotosScreen />);
    expect(screen.getByText('photos_confirm')).toBeTruthy();
  });

  it('returns to an empty home after the final batch without reopening processed photos', () => {
    const view = render(<PhotosScreen />);
    fireEvent.press(screen.getByText('photos_home_start'));
    mockMediaState.photos = [];
    mockMediaState.photoProcessedIds = ['one', 'two', 'three'];
    view.rerender(<PhotosScreen />);

    fireEvent.press(screen.getByText('photos_back_home'));
    expect(screen.getByText('PickPic')).toBeTruthy();
    expect(screen.getByText('photos_home_album')).toBeTruthy();
    expect(screen.queryByText('photos_home_start')).toBeNull();
    expect(mockMediaState.photoProcessedIds).toEqual(['one', 'two', 'three']);
    expect(screen.queryByText('card:one')).toBeNull();
  });

  it('opens an empty home safely when there are no photos at launch', () => {
    mockMediaState.photos = [];
    render(<PhotosScreen />);
    expect(screen.getByText('PickPic')).toBeTruthy();
    expect(screen.getByText('photos_empty')).toBeTruthy();
    expect(screen.getByText('photos_reload')).toBeTruthy();
  });

  it('keeps a restored delete queue in review even when no photos remain', () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = [mockPhoto('one')];
    render(<PhotosScreen />);
    expect(screen.getByText('photos_confirm')).toBeTruthy();
    expect(screen.queryByText('PickPic')).toBeNull();
  });

  it('keeps permission management available from the empty home', () => {
    mockMediaState.photos = [];
    mockMediaState.permissionScope = 'limited';
    render(<PhotosScreen />);
    expect(screen.getByText('photos_manage_access')).toBeTruthy();
    expect(screen.getByText('photos_limited_access_desc')).toBeTruthy();
  });
});
