import { hasDocumentContext, selectImageCategory } from '../../services/ml/LabelClassifier';

const label = (text: string, confidence: number) => ({ text, confidence });

describe('album category evidence', () => {
  it('combines cat breeds when no individual breed clears the old threshold', () => {
    const result = selectImageCategory([
      label('tabby, tabby cat', 0.27), label('Siamese cat, Siamese', 0.24),
      label('Egyptian cat', 0.16), label('golden retriever', 0.12), label('monitor', 0.08),
    ]);
    expect(result?.category).toBe('cat');
    expect(result?.score).toBeCloseTo(0.67);
  });

  it('does not promote a weaker dog prediction above a confident object', () => {
    expect(selectImageCategory([label('sports car', 0.59), label('boxer', 0.41)])?.category)
      .toBe('sports car');
  });

  it('uses scores rather than trusting stored candidate order', () => {
    expect(selectImageCategory([label('boxer', 0.41), label('sports car', 0.59)])?.category)
      .toBe('sports car');
  });

  it('leaves conflicting categories unclassified instead of guessing', () => {
    expect(selectImageCategory([label('sports car', 0.48), label('tabby cat', 0.46)])).toBeNull();
  });

  it('does not invent a person from a phone or a weaker person label', () => {
    expect(selectImageCategory([label('cellular telephone', 0.8), label('groom', 0.15)])?.category)
      .toBe('cellular telephone');
    expect(selectImageCategory([label('groom, bridegroom', 0.85)])?.category).toBe('people');
  });

  it('does not count repeated aliases of one breed multiple times', () => {
    expect(selectImageCategory([
      label('tabby', 0.25), label('Tabby, tabby cat', 0.25), label('monitor', 0.36),
    ])).toBeNull();
  });

  it('leaves the ambiguous cardigan class unclassified without a class index', () => {
    expect(selectImageCategory([label('Cardigan', 0.95)])).toBeNull();
  });

  it('accepts old label fields and ignores malformed or non-finite scores', () => {
    expect(selectImageCategory([
      null, {}, { text: 'dog', confidence: NaN }, { text: 'dog', confidence: 5 },
      { text: 'dog', confidence: -1 }, { label: 'bull', confidence: 0.8 },
    ])?.category).toBe('bull');
  });

  it('does not suppress real faces for a photographed display', () => {
    expect(hasDocumentContext([label('monitor', 0.95)])).toBe(false);
    expect(hasDocumentContext([label('screen, CRT screen', 0.95)])).toBe(false);
  });

  it('recognizes complete ImageNet document aliases and keeps uncertain context neutral', () => {
    expect(hasDocumentContext([label('web site, website, internet site, site', 0.9)])).toBe(true);
    expect(hasDocumentContext([label('groom', 0.59), label('web site', 0.41)])).toBe(false);
    expect(hasDocumentContext([label('groom', 0.48), label('web site', 0.46)])).toBe(false);
  });
});
