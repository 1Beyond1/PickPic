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
    photo('cat', [['tabby', 0.3], ['Siamese cat', 0.3], ['Egyptian cat', 0.15]]),
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
  expect(objects.find(group => group.title === '手机')?.assets.map(asset => asset.asset_id)).toEqual(['phone']);
  expect(objects.find(group => group.title === '截图与文档')?.assets.map(asset => asset.asset_id)).toEqual(['document']);
  expect(objects.some(group => group.assets.some(asset => asset.asset_id === 'car'))).toBe(true);
  expect(objects.some(group => group.title === '狗')).toBe(false);
  expect(result.current.uncategorizedGroup?.assets.map(asset => asset.asset_id)).toEqual(['ambiguous']);
  expect(result.current.isLoading).toBe(false);
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

it('keeps pending work visible without misrepresenting it as completed classification', async () => {
  (AssetRepository.getAllDoneAssets as jest.Mock).mockResolvedValue([]);
  (AssetRepository.getStatusCounts as jest.Mock).mockResolvedValueOnce({ pending: 3, done: 0, error: 0 });
  const { result } = renderHook(() => useAICategories());
  await act(async () => { await result.current.refresh(); });
  expect(result.current.completedCount).toBe(0);
  expect(result.current.uncategorizedGroup).toMatchObject({ count: 3, coverAsset: null, assets: [] });
});
