import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Image, Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

jest.mock('expo-media-library', () => ({ getAssetInfoAsync: jest.fn(), getAssetsAsync: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../hooks/useThemeColor', () => ({ useThemeColor: () => ({ colors: require('../../constants/theme').COLORS_DARK }) }));
jest.mock('../../hooks/useI18n', () => ({ useI18n: () => ({
  t: (key: string, params?: { count: number }) => key === 'scan_photo_count' ? `${params?.count} photos` : key,
}) }));

import { SimilarGroupCard } from '../../components/SimilarGroupCard';

const props = { groupId: 'group', memberCount: 2, memberAssetIds: ['first', 'second'], onPress: jest.fn() };
beforeEach(() => {
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg` }));
});

it('describes the group and its actual count outside the preview images', async () => {
  render(<SimilarGroupCard {...props} />);
  await waitFor(() => expect(screen.UNSAFE_getAllByType(Image)).toHaveLength(2));
  expect(screen.getByRole('button', { name: 'similar_group_detail_title, 2 photos' })).toBeEnabled();
  expect(screen.getByText('2 photos')).toBeTruthy();
  expect(screen.getByText('similar_group_detail_title').props.numberOfLines).toBeUndefined();
  expect(screen.UNSAFE_getAllByType(Image).map(image => image.props.source.uri)).toEqual(['file:///first.jpg', 'file:///second.jpg']);
  expect(props.onPress).not.toHaveBeenCalled();
});

it('keeps a processed group readable and identifiable rather than disabling it', async () => {
  render(<SimilarGroupCard {...props} isProcessed />);
  await waitFor(() => expect(screen.UNSAFE_getAllByType(Image)).toHaveLength(2));
  const card = screen.getByRole('button', { name: 'similar_group_detail_title, 2 photos, similar_group_processed' });
  expect(card).toBeEnabled();
  expect(screen.getByText('similar_group_processed')).toBeTruthy();
  expect(card).not.toHaveStyle({ opacity: 0.6 });
});

it('ignores a delayed old thumbnail request after a different group is shown', async () => {
  let resolveOld!: (info: { uri: string }) => void;
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const view = render(<SimilarGroupCard {...props} />);
  view.rerender(<SimilarGroupCard {...props} groupId="new" memberCount={3} memberAssetIds={['new-1', 'new-2', 'new-3']} />);
  await waitFor(() => expect(screen.UNSAFE_getAllByType(Image).map(image => image.props.source.uri)).toEqual(['file:///new-1.jpg', 'file:///new-2.jpg']));
  await act(async () => { resolveOld({ uri: 'file:///old.jpg' }); });
  expect(screen.UNSAFE_getAllByType(Image).map(image => image.props.source.uri)).toEqual(['file:///new-1.jpg', 'file:///new-2.jpg']);
  expect(screen.getByRole('button', { name: 'similar_group_detail_title, 3 photos' })).toBeTruthy();
});

it('does not leave loaded old thumbnails visible while another group is loading', async () => {
  const view = render(<SimilarGroupCard {...props} />);
  await waitFor(() => expect(screen.UNSAFE_getAllByType(Image)).toHaveLength(2));
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(() => new Promise(() => {}));
  view.rerender(<SimilarGroupCard {...props} groupId="new" memberAssetIds={['new-1', 'new-2']} />);
  expect(screen.UNSAFE_queryAllByType(Image)).toHaveLength(0);
});

it('uses the existing metadata-only fallback for Android photos without location permission', async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockRejectedValue(new Error('Missing ACCESS_MEDIA_LOCATION permission'));
  (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValue({ assets: props.memberAssetIds.map(id => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg` })), hasNextPage: false });
  render(<SimilarGroupCard {...props} />);
  await waitFor(() => expect(screen.UNSAFE_getAllByType(Image)).toHaveLength(2));
  expect(MediaLibrary.getAssetsAsync).toHaveBeenCalledWith(expect.objectContaining({ resolveWithFullInfo: false, mediaType: 'photo' }));
  expect(MediaLibrary.getAssetInfoAsync).toHaveBeenCalledWith('first', { shouldDownloadFromNetwork: false });
});

it('does not show wrong-ID, wrong-type or URI-less results as group members', async () => {
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockResolvedValueOnce({ id: 'other', mediaType: 'photo', uri: 'file:///other.jpg' })
    .mockResolvedValueOnce({ id: 'second', mediaType: 'video', uri: 'file:///video.mp4' });
  render(<SimilarGroupCard {...props} />);
  await waitFor(() => expect(MediaLibrary.getAssetInfoAsync).toHaveBeenCalledTimes(2));
  expect(screen.UNSAFE_queryAllByType(Image)).toHaveLength(0);
});
