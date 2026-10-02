import { getCategoryGroup } from '../../services/ml/CategoryGrouper';
import { IMAGENET_LABELS } from '../../services/ml/ImageNetLabels';

describe('ImageNet category meaning', () => {
  it.each(['bull', 'cardigan', 'crane', 'kite', 'maillot', 'car mirror', 'car wheel', 'freight car', 'unknown breed'])('%s remains unknown instead of guessing', label => {
    expect(getCategoryGroup(label)).toBeNull();
  });

  it.each(['cellular telephone', 'hand-held computer', 'bikini', 'lab coat', 'miniskirt'])(
    '%s alone does not prove a person is present', label => {
      expect(getCategoryGroup(label)).not.toBe('people');
    },
  );

  it.each(['monitor', 'screen, CRT screen'])('%s can be a photographed object, not a screenshot', label => {
    expect(getCategoryGroup(label)).toBe('electronics');
  });

  it.each([
    ['bull mastiff', 'dog'], ['Boston bull', 'dog'], ['Cardigan Welsh corgi', 'dog'], ['golden retriever', 'dog'],
    ['tiger cat', 'cat'], ['Egyptian cat', 'cat'], ['robin', 'bird'],
    ['groom, bridegroom', 'people'], ['ballplayer, baseball player', 'people'],
    ['web site, website, internet site, site', 'documents'],
    ['sports car, sport car', 'car'], ['model t', 'car'], ['minivan', 'car'],
    ['hotdog, hot dog, red hot', 'food'], ['prairie dog', 'animal'],
    ['Madagascar cat', 'animal'], ['bullfrog', 'animal'],
    ['lakeside, lakeshore', 'landscape'], ['pizza', 'food'], ['daisy', 'plant'],
  ])('retains %s as %s', (label, category) => {
    expect(getCategoryGroup(label)).toBe(category);
  });

  it('covers every bundled domestic dog and cat breed without introducing breed directories', () => {
    const dogs = IMAGENET_LABELS.slice(IMAGENET_LABELS.indexOf('chihuahua'), IMAGENET_LABELS.indexOf('mexican hairless') + 1);
    for (const breed of dogs) expect(getCategoryGroup(breed)).toBe(breed === 'cardigan' ? null : 'dog');
    const cats = IMAGENET_LABELS.slice(IMAGENET_LABELS.indexOf('tabby'), IMAGENET_LABELS.indexOf('egyptian cat') + 1);
    for (const breed of cats) expect(getCategoryGroup(breed)).toBe('cat');
  });
});
