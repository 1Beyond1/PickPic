import {
  calculateBestShotScore,
  chooseBestShotAssetId,
} from '../../database/bestShotScoring';

describe('best-shot scoring', () => {
  it('chooses the highest-quality candidate rather than the nearest duplicate', () => {
    const selected = chooseBestShotAssetId([
      {
        asset_id: 'blurry',
        width: 4000,
        height: 3000,
        blur_score: 10,
        mean_luma: 70,
      },
      {
        asset_id: 'sharp',
        width: 2000,
        height: 1500,
        blur_score: 350,
        mean_luma: 140,
      },
    ]);

    expect(selected).toBe('sharp');
  });

  it('preserves the caller-provided order for exact score ties', () => {
    const first = {
      asset_id: 'first',
      width: 1000,
      height: 1000,
      blur_score: 100,
      mean_luma: 140,
    };
    const second = { ...first, asset_id: 'second' };

    expect(calculateBestShotScore(first)).toBe(calculateBestShotScore(second));
    expect(chooseBestShotAssetId([first, second])).toBe('first');
    expect(chooseBestShotAssetId([])).toBeNull();
  });
});
