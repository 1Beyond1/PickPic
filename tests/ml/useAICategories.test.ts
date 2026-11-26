import { act, renderHook } from '@testing-library/react-native';
import { AssetRepository } from '../../database';
import { useAICategories } from '../../hooks/useAICategories';

jest.mock('../../database', () => ({
  AssetRepository: {
    getAllDoneAssets: jest.fn(),
    getStatusCounts: jest.fn().mockResolvedValue({ pending: 0, done: 0, error: 0 }),
  },
}));
jest.mock('expo-media-library', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, accessPrivileges: 'all' }),
}));
jest.mock('../../hooks/useI18n', () => ({ useI18n: () => ({ language: 'zh' }) }));

const photo = (id: string, labels: [string, number][], faceCount = 0) => ({
  asset_id: id,
  face_count: faceCount,
  labels_json: JSON.stringify(labels.map(([text, confidence]) => ({ text, confidence }))),
});

it('categorizes saved scans without weaker priors and keeps uncertainty in the unclassified list', async () => {
  (AssetRepository.getAllDoneAssets as jest.Mock).mockResolvedValue([
    photo('cat', [['tabby', 0.65], ['Siamese cat', 0.2], ['Egyptian cat', 0.15]]),
    photo('car', [['sports car', 0.59], ['boxer', 0.41]]),
    photo('phone', [['cellular telephone', 0.85]]),
    photo('ambiguous', [['sports car', 0.48], ['tabby', 0.46]]),
    photo('real-person', [['monitor', 0.8]], 1),
    photo('document', [['web site, website, internet site, site', 0.9]], 1),
  ]);
  const { result } = renderHook(() => useAICategories());
  await act(async () => { await result.current.refresh(); });

  expect(result.current.peopleGroups.flatMap(group => group.assets.map(asset => asset.asset_id)))
    .toEqual(['real-person']);
  const objects = result.current.objectGroups;
  expect(objects.find(group => group.title === '猫')?.assets.map(asset => asset.asset_id)).toEqual(['cat']);
  expect(objects.find(group => group.title === '电子设备')?.assets.map(asset => asset.asset_id)).toEqual(['phone', 'real-person']);
  expect(objects.find(group => group.title === '图文资料')?.assets.map(asset => asset.asset_id)).toEqual(['document']);
  expect(objects.find(group => group.title === '汽车')?.assets.map(asset => asset.asset_id)).toEqual(['car']);
  expect(objects.some(group => group.assets.some(asset => asset.asset_id === 'car'))).toBe(true);
  expect(objects.some(group => group.title === '狗')).toBe(false);
  expect(result.current.uncategorizedGroup?.assets.map(asset => asset.asset_id)).toEqual(['ambiguous']);
  expect(result.current.isLoading).toBe(false);
});

it('reuses original saved labels and counts a person with a dog once in overall progress', async () => {
  const raw = photo('together', [['golden retriever', 0.85]], 1);
  const before = raw.labels_json;
  (AssetRepository.getAllDoneAssets as jest.Mock).mockResolvedValue([raw]);
  const { result } = renderHook(() => useAICategories());
  await act(async () => { await result.current.refresh(); });
  expect(result.current.completedCount).toBe(1);
  expect(result.current.peopleGroups[0].assets).toEqual([raw]);
  expect(result.current.objectGroups[0]).toMatchObject({ id: 'category_dog', title: '狗', count: 1 });
  expect(result.current.uncategorizedGroup).toBeNull();
  expect(raw.labels_json).toBe(before);
});

it('reports a failed category read and clears the error after a successful explicit retry', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (AssetRepository.getAllDoneAssets as jest.Mock).mockRejectedValueOnce(new Error('SQLite busy')).mockResolvedValue([]);
  const { result } = renderHook(() => useAICategories());
  await act(async () => { await result.current.refresh(); });
  expect(result.current).toMatchObject({ hasError: true, isLoading: false, peopleGroups: [], objectGroups: [], uncategorizedGroup: null });
  await act(async () => { await result.current.refresh(); });
  expect(result.current).toMatchObject({ hasError: false, completedCount: 0, isLoading: false });
});

it('does not publish an old request failure over a newer successful snapshot', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  let fail!: (error: Error) => void;
  const stale = new Promise<never>((_resolve, reject) => { fail = reject; });
  (AssetRepository.getAllDoneAssets as jest.Mock).mockReturnValueOnce(stale).mockResolvedValue([photo('new', [['tabby', 0.9]])]);
  const { result } = renderHook(() => useAICategories());
  let first!: Promise<void>;
  await act(async () => { first = result.current.refresh(); });
  await act(async () => { await result.current.refresh(); });
  await act(async () => { fail(new Error('Old read failed')); await first; });
  expect(result.current).toMatchObject({ hasError: false, completedCount: 1, isLoading: false });
  expect(result.current.objectGroups.flatMap(group => group.assets.map(asset => asset.asset_id))).toEqual(['new']);
});

it('reports failed reads without logging provider errors containing private record data', async () => {
  const privateMarker = 'PRIVATE_RECORD_LABEL_AND_MEDIA_PATH';
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  (AssetRepository.getAllDoneAssets as jest.Mock).mockRejectedValueOnce(new Error(privateMarker));
  const { result } = renderHook(() => useAICategories());
  await act(async () => { await result.current.refresh(); });
  expect(result.current).toMatchObject({ hasError: true, isLoading: false });
  expect(log).toHaveBeenCalled();
  const logged = log.mock.calls.flat().map(value => value instanceof Error ? value.message : String(value)).join('\n');
  expect(logged).not.toContain(privateMarker);
});

it('keeps pending work visible without misrepresenting it as completed classification', async () => {
  (AssetRepository.getAllDoneAssets as jest.Mock).mockResolvedValue([]);
  (AssetRepository.getStatusCounts as jest.Mock).mockResolvedValueOnce({ pending: 3, done: 0, error: 0 });
  const { result } = renderHook(() => useAICategories());
  await act(async () => { await result.current.refresh(); });
  expect(result.current.completedCount).toBe(0);
  expect(result.current.uncategorizedGroup).toMatchObject({ count: 3, coverAsset: null, assets: [] });
});
