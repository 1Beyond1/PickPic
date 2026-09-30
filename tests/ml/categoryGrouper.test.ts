import { getCategoryGroup } from '../../services/ml/CategoryGrouper';

describe('ImageNet category meaning', () => {
  it.each(['bull', 'bullfrog', 'prairie dog', 'hotdog', 'hotdog, hot dog, red hot', 'cardigan', 'Madagascar cat'])('%s must not be forced into a pet category', label => {
    expect(getCategoryGroup(label)).toBeNull();
  });

  it.each(['cellular telephone', 'hand-held computer', 'bikini', 'lab coat', 'miniskirt'])(
    '%s alone does not prove a person is present', label => {
      expect(getCategoryGroup(label)).toBeNull();
    },
  );

  it.each(['monitor', 'screen, CRT screen'])('%s can be a photographed object, not a screenshot', label => {
    expect(getCategoryGroup(label)).toBeNull();
  });

  it.each([
    ['bull mastiff', 'dog'], ['Boston bull', 'dog'], ['Cardigan Welsh corgi', 'dog'], ['golden retriever', 'dog'],
    ['tiger cat', 'cat'], ['Egyptian cat', 'cat'], ['robin', 'bird'],
    ['groom, bridegroom', 'people'], ['ballplayer, baseball player', 'people'],
    ['web site, website, internet site, site', 'screenshot'],
  ])('retains %s as %s', (label, category) => {
    expect(getCategoryGroup(label)).toBe(category);
  });
});
