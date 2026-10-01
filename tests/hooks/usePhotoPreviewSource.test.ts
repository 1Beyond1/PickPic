import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as MediaLibrary from 'expo-media-library';
jest.mock('expo-media-library', () => ({ getAssetInfoAsync: jest.fn() }));
import { usePhotoPreviewSource } from '../../hooks/usePhotoPreviewSource';

it.each(['rejected', 'no-uri'])('keeps a %s retry recoverable without replacing the asset', async failure => {
    const query = jest.mocked(MediaLibrary.getAssetInfoAsync);
    if (failure === 'rejected') query.mockRejectedValueOnce(new Error('Provider unavailable'));
    else query.mockResolvedValueOnce({} as any);
    const { result } = renderHook(() => usePhotoPreviewSource('file:///photo.jpg', 'photo'));
    expect(query).not.toHaveBeenCalled();
    act(() => result.current.onError());
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(query).toHaveBeenCalledWith('photo');
    query.mockResolvedValueOnce({ localUri: 'file:///recovered.jpg' } as any);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.uri).toBe('file:///recovered.jpg'));
    expect(result.current.failed).toBe(false);
});

it('ignores an old decoder error after retrying the same URI successfully', async () => {
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockResolvedValueOnce({ uri: 'file:///photo.jpg' } as any);
    const { result } = renderHook(() => usePhotoPreviewSource('file:///photo.jpg', 'photo'));
    const oldError = result.current.onError;
    act(() => oldError());
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failed).toBe(false);
    act(() => oldError());
    expect(result.current.failed).toBe(false);
});

it('can retry a legacy URI-only preview without querying a different media asset', async () => {
    const { result } = renderHook(() => usePhotoPreviewSource('file:///legacy.jpg'));
    act(() => result.current.onError());
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.uri).toBe('file:///legacy.jpg');
    expect(result.current.failed).toBe(false);
    expect(MediaLibrary.getAssetInfoAsync).not.toHaveBeenCalled();
});

it('discards an unfinished retry when the preview is unmounted', async () => {
    let resolve!: (value: any) => void;
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockReturnValueOnce(new Promise(value => { resolve = value; }));
    const { result, unmount } = renderHook(() => usePhotoPreviewSource('file:///photo.jpg', 'photo'));
    act(() => result.current.onError());
    act(() => result.current.retry());
    expect(result.current.loading).toBe(true);
    unmount();
    await act(async () => resolve({ localUri: 'file:///late.jpg' }));
    expect(result.current.uri).toBeUndefined();
});
