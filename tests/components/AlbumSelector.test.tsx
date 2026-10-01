import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking, Modal } from 'react-native';

const mockLoadAlbums = jest.fn().mockResolvedValue(undefined);
const mockFullAccess = jest.fn().mockResolvedValue(true);
const mockAlbums = [
    { id: 'photos', title: 'Camera', assetCount: 12, type: 'album' },
    { id: 'videos', title: 'Movies', assetCount: 3, type: 'album' },
    { id: 'smart', title: 'Favorites', assetCount: 2, type: 'smartAlbum' },
];
let mockVisibleAlbums = mockAlbums;
jest.mock('../../stores/useMediaStore', () => ({
    useMediaStore: () => ({ albums: mockVisibleAlbums, loadAlbums: mockLoadAlbums }),
    hasFullPhotoLibraryAccess: () => mockFullAccess(),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, Feather: () => null }));
jest.mock('../../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../hooks/useThemeColor', () => ({ useThemeColor: () => ({ colors: require('../../constants/theme').COLORS }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 32, left: 0, right: 0 }) }));

import { AlbumSelector } from '../../components/AlbumSelector';

beforeEach(() => {
    jest.clearAllMocks();
    mockVisibleAlbums = mockAlbums;
    mockFullAccess.mockResolvedValue(true);
});

it('edits a draft and applies only the confirmed album IDs', async () => {
    const onConfirm = jest.fn();
    render(<AlbumSelector visible onClose={jest.fn()} onConfirm={onConfirm} initialSelection={['photos']} />);
    const movies = await screen.findByRole('checkbox', { name: 'Movies' });
    expect(screen.getByRole('checkbox', { name: 'Camera', checked: true })).toBeTruthy();
    fireEvent.press(movies);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'confirm' }));
    expect(onConfirm).toHaveBeenCalledWith(['photos', 'videos']);
});

it('close, scrim and Android back cancel without applying the draft, and reopening restores the saved selection', async () => {
    const onClose = jest.fn();
    const onConfirm = jest.fn();
    const saved = ['photos'];
    const view = render(<AlbumSelector visible onClose={onClose} onConfirm={onConfirm} initialSelection={saved} />);
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Movies' }));
    fireEvent.press(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.press(screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }));
    act(() => view.UNSAFE_getByType(Modal).props.onRequestClose());
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
    view.rerender(<AlbumSelector visible={false} onClose={onClose} onConfirm={onConfirm} initialSelection={saved} />);
    view.rerender(<AlbumSelector visible onClose={onClose} onConfirm={onConfirm} initialSelection={saved} />);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Movies', checked: false })).toBeTruthy());
    expect(screen.getByRole('checkbox', { name: 'Camera', checked: true })).toBeTruthy();
});

it('clears only the draft; all-albums scope is applied only after confirm', async () => {
    const onConfirm = jest.fn();
    render(<AlbumSelector visible onClose={jest.fn()} onConfirm={onConfirm} initialSelection={['photos']} />);
    await screen.findByRole('checkbox', { name: 'Camera' });
    fireEvent.press(screen.getByRole('button', { name: 'album_filter_all' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'Camera', checked: false })).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'confirm' }));
    expect(onConfirm).toHaveBeenCalledWith([]);
});

it('preserves max-selection and editable-album constraints', async () => {
    render(<AlbumSelector visible onClose={jest.fn()} onConfirm={jest.fn()} initialSelection={['photos']} maxSelection={1} editableOnly />);
    await screen.findByRole('checkbox', { name: 'Camera' });
    expect(screen.queryByRole('checkbox', { name: 'Favorites' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Movies', disabled: true })).toBeTruthy();
    fireEvent.press(screen.getByRole('checkbox', { name: 'Movies' }));
    expect(screen.getByRole('checkbox', { name: 'Movies', checked: false })).toBeTruthy();
    fireEvent.press(screen.getByRole('checkbox', { name: 'Camera' }));
    fireEvent.press(screen.getByRole('checkbox', { name: 'Movies' }));
    expect(screen.getByRole('checkbox', { name: 'Movies', checked: true })).toBeTruthy();
});

it('does not expose cached albums without full access, and offers system settings', async () => {
    mockFullAccess.mockResolvedValue(false);
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    render(<AlbumSelector visible onClose={jest.fn()} onConfirm={jest.fn()} />);
    await screen.findByText('album_full_access_required');
    expect(screen.queryByRole('checkbox', { name: 'Camera' })).toBeNull();
    expect(mockLoadAlbums).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'album_open_settings' }));
    expect(openSettings).toHaveBeenCalledTimes(1);
    openSettings.mockRestore();
});

it('explains an empty album list without applying an empty scope automatically', async () => {
    mockVisibleAlbums = [];
    const onConfirm = jest.fn();
    render(<AlbumSelector visible onClose={jest.fn()} onConfirm={onConfirm} initialSelection={['missing-album']} />);
    await screen.findByText('album_selector_empty');
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'confirm' }));
    expect(onConfirm).toHaveBeenCalledWith(['missing-album']);
});
