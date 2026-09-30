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
