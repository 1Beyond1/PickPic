import { hasDocumentContext, selectImageCategories, selectImageCategory } from '../../services/ml/LabelClassifier';

const label = (text: string, confidence: number) => ({ text, confidence });

describe('album category evidence', () => {
  it('does not turn several weak breed guesses into a confident category', () => {
    const result = selectImageCategory([
      label('tabby, tabby cat', 0.27), label('Siamese cat, Siamese', 0.24),
      label('Egyptian cat', 0.16), label('golden retriever', 0.12), label('monitor', 0.08),
    ]);
    expect(result).toBeNull();
  });

  it('does not promote a weaker dog prediction above a confident object', () => {
    expect(selectImageCategory([label('sports car', 0.59), label('boxer', 0.41)])?.category)
      .toBe('car');
  });

  it('uses scores rather than trusting stored candidate order', () => {
    expect(selectImageCategory([label('boxer', 0.41), label('sports car', 0.59)])?.category)
      .toBe('car');
  });

  it('leaves conflicting categories unclassified instead of guessing', () => {
    expect(selectImageCategory([label('sports car', 0.48), label('tabby cat', 0.46)])).toBeNull();
  });

  it('does not invent a person from a phone or a weaker person label', () => {
    expect(selectImageCategory([label('cellular telephone', 0.8), label('groom', 0.15)])?.category)
      .toBe('electronics');
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
    ])).toBeNull();
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

  it('keeps the strongest actual breed score instead of adding or counting aliases', () => {
    expect(selectImageCategory([label('tabby', 0.65), label('tabby, tabby cat', 0.65), label('siamese cat', 0.2)]))
      .toEqual({ category: 'cat', score: 0.65 });
  });

  it('does not discard a stronger unmapped candidate to promote a weaker familiar label', () => {
    expect(selectImageCategory([label('abacus', 0.8), label('golden retriever', 0.45)])).toBeNull();
  });

  it('supports independently evidenced people and objects while rejecting competing hypotheses', () => {
    expect(selectImageCategories([label('golden retriever', 0.8)], 1)).toEqual(['people', 'dog']);
    expect(selectImageCategories([label('sports car', 0.8)], 2)).toEqual(['people', 'car']);
    expect(selectImageCategories([label('tabby', 0.48), label('boxer', 0.46)])).toEqual([]);
    expect(selectImageCategories([label('web site', 0.9)], 1)).toEqual(['documents']);
    expect(selectImageCategories([], 1)).toEqual(['people']);
    expect(selectImageCategories([], NaN)).toEqual([]);
  });
});
