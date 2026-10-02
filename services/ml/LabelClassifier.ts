import { AlbumCategory, getCategoryGroup } from './CategoryGrouper';

// Keep the acceptance floor and ambiguity margin. Scores are model evidence,
// not calibrated accuracy. ImageNet classes are competing hypotheses; adding
// weak breeds together must not manufacture a stronger prediction.
const MIN_CATEGORY_SCORE = 0.4;
const MIN_CATEGORY_MARGIN = 0.08;
interface CategoryEvidence { category: AlbumCategory; score: number }

export function selectImageCategory(labels: readonly unknown[]): CategoryEvidence | null {
    const candidates = new Map<string, { category: AlbumCategory | null; score: number }>();
    for (const value of labels) {
        if (!value || typeof value !== 'object') continue;
        const candidate = value as { text?: unknown; label?: unknown; confidence?: unknown };
        const text = typeof candidate.text === 'string' && candidate.text.trim()
            ? candidate.text.trim() : typeof candidate.label === 'string' ? candidate.label.trim() : '';
        const score = candidate.confidence;
        if (!text || typeof score !== 'number' || !Number.isFinite(score) || score <= 0 || score > 1) continue;
        const category = getCategoryGroup(text);
        // Unknown classes still compete; hiding them would promote weak guesses.
        const key = category ?? `unknown:${text.toLowerCase().split(',')[0].trim()}`;
        if (score > (candidates.get(key)?.score ?? 0)) candidates.set(key, { category, score });
    }
    const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
    const winner = ranked[0];
    if (!winner?.category || winner.score < MIN_CATEGORY_SCORE) return null;
    if (ranked[1] && winner.score - ranked[1].score < MIN_CATEGORY_MARGIN) return null;
    return { category: winner.category, score: winner.score };
}

/** ImageNet alternatives do not establish multiple visible objects. Independent
 * face evidence may coexist with one reliable object/scene class. Close cat/dog
 * alternatives are never turned into two tags. */
export function selectImageCategories(labels: readonly unknown[], faceCount = 0): AlbumCategory[] {
    const selection = selectImageCategory(labels);
    const categories: AlbumCategory[] = selection ? [selection.category] : [];
    if (Number.isSafeInteger(faceCount) && faceCount > 0 && selection?.category !== 'documents'
        && !categories.includes('people')) categories.unshift('people');
    return categories;
}
export function hasDocumentContext(labels: readonly unknown[]): boolean {
    return selectImageCategory(labels)?.category === 'documents';
}
