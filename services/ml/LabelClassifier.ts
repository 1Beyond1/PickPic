import { getCategoryGroup } from './CategoryGrouper';

// Keep the existing 0.4 acceptance floor, applied after related ImageNet
// classes are grouped. The margin is a conservative heuristic, not a
// calibrated probability; it needs evaluation on real album photos.
const MIN_CATEGORY_SCORE = 0.4;
const MIN_CATEGORY_MARGIN = 0.08;

interface CategoryEvidence {
    category: string;
    score: number;
}

/** Select a category from current or legacy persisted labels. */
export function selectImageCategory(labels: readonly unknown[]): CategoryEvidence | null {
    const uniqueLabels = new Map<string, { text: string; confidence: number }>();
    for (const value of labels) {
        if (!value || typeof value !== 'object') continue;
        const candidate = value as { text?: unknown; label?: unknown; confidence?: unknown };
        const text = typeof candidate.text === 'string' && candidate.text.trim()
            ? candidate.text.trim()
            : typeof candidate.label === 'string' ? candidate.label.trim() : '';
        const confidence = candidate.confidence;
        if (!text || typeof confidence !== 'number' || !Number.isFinite(confidence)
            || confidence <= 0 || confidence > 1) continue;
        // Aliases of one class must not count as independent evidence.
        const key = text.toLowerCase().split(',')[0].trim();
        if (confidence > (uniqueLabels.get(key)?.confidence ?? 0)) {
            uniqueLabels.set(key, { text, confidence });
        }
    }

    const categories = new Map<string, CategoryEvidence>();
    for (const { text, confidence } of uniqueLabels.values()) {
        const category = getCategoryGroup(text) ?? text;
        const key = category.toLowerCase();
        const existing = categories.get(key);
        if (existing) existing.score = Math.min(1, existing.score + confidence);
        else categories.set(key, { category, score: confidence });
    }

    const ranked = Array.from(categories.values()).sort((a, b) => b.score - a.score);
    const winner = ranked[0];
    if (!winner || winner.score < MIN_CATEGORY_SCORE) return null;
    // The current persisted output omits class indices. Both ImageNet
    // "cardigan" classes become the same text, so do not guess dog vs garment.
    if (winner.category.toLowerCase().split(',')[0].trim() === 'cardigan') return null;
    if (ranked[1] && winner.score - ranked[1].score < MIN_CATEGORY_MARGIN) return null;
    return winner;
}

/** A photographed monitor alone does not establish a screenshot/document. */
export function hasDocumentContext(labels: readonly unknown[]): boolean {
    return selectImageCategory(labels)?.category === 'screenshot';
}
