import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockRouter = { back: jest.fn(), replace: jest.fn() };
let mockParams: { uri: string | string[]; assetId?: string | string[] };
const mockMediaState = {
  permissionScope: 'full', permissionRefreshVersion: 0, mediaLibraryRefreshVersion: 0,
};
let mockInsets = { top: 32, bottom: 24, left: 0, right: 0 };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));
jest.mock('expo-media-library', () => ({ getAssetInfoAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('expo-image', () => ({
  Image: (props: object) => require('react').createElement(require('react-native').View, {
    ...props, testID: 'detail-image',
  }),
}));
jest.mock('expo-blur', () => ({ BlurView: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => mockInsets }));
jest.mock('../components/ScalablePressable', () => ({
  ScalablePressable: (props: object) => require('react').createElement(require('react-native').Pressable, props),
}));
jest.mock('../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../hooks/useThemeColor', () => ({
  useThemeColor: () => ({ isDark: true, colors: { background: '#111212', text: '#F1F2EF', surfaceHover: '#232524' } }),
}));
jest.mock('../stores/useMediaStore', () => ({
  useMediaStore: (selector: (state: typeof mockMediaState) => unknown) => selector(mockMediaState),
}));

import PhotoDetailScreen from '../app/photo-detail';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';

// Baseline controls have no accessible names. Select distinct handlers rather
// than teaching their mocks the accessible roles the redesign must provide.
function control(index: number) {
  const seen = new Set<unknown>();
  return screen.root.findAll((node: { props: { onPress?: unknown } }) => {
    if (typeof node.props.onPress !== 'function' || seen.has(node.props.onPress)) return false;
    seen.add(node.props.onPress);
    return true;
  })[index];
}

describe('Photo detail navigation and sharing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { uri: 'file:///photo.jpg', assetId: 'photo' };
    mockMediaState.permissionScope = 'full';
    mockMediaState.permissionRefreshVersion = 0;
    mockMediaState.mediaLibraryRefreshVersion = 0;
    mockInsets = { top: 32, bottom: 24, left: 0, right: 0 };
    jest.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);
    jest.mocked(Sharing.shareAsync).mockResolvedValue(undefined);
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockResolvedValue({ localUri: 'file:///resolved.jpg' } as any);
  });

  it('displays the complete route photo without initiating sharing or media lookups', () => {
    render(<PhotoDetailScreen />);
    expect(screen.getByTestId('detail-image').props).toMatchObject({
      source: { uri: 'file:///photo.jpg' }, contentFit: 'contain',
    });
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    expect(MediaLibrary.getAssetInfoAsync).not.toHaveBeenCalled();
  });

  it('explains decode failure and retries the same asset without sharing or redirecting', async () => {
    render(<PhotoDetailScreen />);
    fireEvent(screen.getByTestId('detail-image'), 'error', { error: 'Decoder failed' });
    expect(screen.getByText('scan_photo_unavailable')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(screen.getByTestId('detail-image').props.source.uri).toBe('file:///resolved.jpg'));
    expect(MediaLibrary.getAssetInfoAsync).toHaveBeenCalledWith('photo');
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'photo_detail_back' }));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('exposes understandable back and share actions rather than icon glyphs', () => {
    render(<PhotoDetailScreen />);
    expect(screen.getByRole('button', { name: 'photo_detail_back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'photo_detail_share' })).toBeTruthy();
  });

  it('shares the recovered source only after an explicit share action', async () => {
    render(<PhotoDetailScreen />);
    fireEvent(screen.getByTestId('detail-image'), 'error', { error: 'Decoder failed' });
    fireEvent.press(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(screen.getByTestId('detail-image').props.source.uri).toBe('file:///resolved.jpg'));
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'photo_detail_share' }));
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///resolved.jpg'));
  });

  it('does not let a late initial Apple URI lookup overwrite a recovered share source', async () => {
    let resolveInitial!: (value: any) => void;
    mockParams = { uri: 'ph://photo', assetId: 'photo' };
    jest.mocked(MediaLibrary.getAssetInfoAsync)
      .mockReturnValueOnce(new Promise(resolve => { resolveInitial = resolve; }))
      .mockResolvedValueOnce({ localUri: 'file:///recovered.jpg' } as any);
    render(<PhotoDetailScreen />);
    fireEvent(screen.getByTestId('detail-image'), 'error', { error: 'Decoder failed' });
    fireEvent.press(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(screen.getByTestId('detail-image').props.source.uri).toBe('file:///recovered.jpg'));
    await act(async () => resolveInitial({ localUri: 'file:///outdated.jpg' }));
    fireEvent.press(screen.getByRole('button', { name: 'photo_detail_share' }));
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///recovered.jpg'));
  });

  it('keeps safe areas outside the media and fixed 44dp controls beside a wrapping title', () => {
    mockInsets = { top: 40, bottom: 30, left: 12, right: 16 };
    render(<PhotoDetailScreen />);
    expect(screen.getByTestId('photo-detail')).toHaveStyle({
      paddingTop: 48, paddingBottom: 30, paddingLeft: 12, paddingRight: 16,
    });
    expect(screen.getByTestId('photo-detail-media')).toHaveStyle({ flex: 1, minHeight: 0 });
    expect(screen.getByRole('button', { name: 'photo_detail_back' })).toHaveStyle({ width: 44, height: 44, flexShrink: 0 });
    expect(screen.getByRole('button', { name: 'photo_detail_share' })).toHaveStyle({ width: 44, height: 44, flexShrink: 0 });
    expect(screen.getByRole('header')).toHaveStyle({ flex: 1, minWidth: 0 });
    expect(screen.getByRole('header').props.numberOfLines).toBeUndefined();
  });

  it('returns to the existing screen without redirecting or sharing', () => {
    render(<PhotoDetailScreen />);
    fireEvent.press(control(0));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });

  it('shares a local file only after explicit activation', async () => {
    render(<PhotoDetailScreen />);
    fireEvent.press(control(1));
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///photo.jpg'));
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('does not attempt to share when the platform cannot share', async () => {
    jest.mocked(Sharing.isAvailableAsync).mockResolvedValue(false);
    render(<PhotoDetailScreen />);
    await act(async () => fireEvent.press(control(1)));
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });

  it('normalizes array params and resolves Apple library URIs to a shareable file', async () => {
    mockParams = { uri: ['ph://photo', 'ph://ignored'], assetId: ['photo', 'ignored'] };
    render(<PhotoDetailScreen />);
    await waitFor(() => expect(MediaLibrary.getAssetInfoAsync).toHaveBeenCalledWith('photo'));
    await act(async () => fireEvent.press(control(1)));
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///resolved.jpg');
    expect(screen.getByTestId('detail-image').props.source).toEqual({ uri: 'ph://photo' });
  });

  it.each(['full', 'none'])('leaves stale details when %s permission is refreshed', scope => {
    const view = render(<PhotoDetailScreen />);
    mockMediaState.permissionScope = scope;
    mockMediaState.permissionRefreshVersion++;
    view.rerender(<PhotoDetailScreen />);
    expect(mockRouter.replace).toHaveBeenCalledWith(scope === 'none' ? '/' : '/(tabs)/photos');
  });

  it('leaves a removed asset after a library refresh without initiating deletion', async () => {
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockResolvedValue(null as any);
    const view = render(<PhotoDetailScreen />);
    mockMediaState.mediaLibraryRefreshVersion++;
    view.rerender(<PhotoDetailScreen />);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/photos'));
    expect(MediaLibrary.getAssetInfoAsync).toHaveBeenCalledWith('photo', { shouldDownloadFromNetwork: false });
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });
});
