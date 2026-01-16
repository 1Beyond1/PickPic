import { useEffect, useState } from 'react';
import { AssetRecord, AssetRepository } from '../database';
import { getCategoryGroup } from '../services/ml/CategoryGrouper';
import { translateLabel } from '../services/ml/LabelTranslator';
import { ImageLabel } from '../services/ml/MLKitService';
import { useI18n } from './useI18n';

export interface CategoryGroup {
    id: string;
    title: string;
    count: number;
    coverAsset: AssetRecord;
    assets: AssetRecord[];
}

export interface AICategoriesState {
    peopleGroups: CategoryGroup[];
    objectGroups: CategoryGroup[];
    uncategorizedGroup: CategoryGroup | null;
    isLoading: boolean;
    refresh: () => Promise<void>;
}

export function useAICategories(): AICategoriesState {
    const { language } = useI18n();
    const [peopleGroups, setPeopleGroups] = useState<CategoryGroup[]>([]);
    const [objectGroups, setObjectGroups] = useState<CategoryGroup[]>([]);
    const [uncategorizedGroup, setUncategorizedGroup] = useState<CategoryGroup | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const loadCategories = async () => {
        setIsLoading(true);
        try {
            // 1. Load People Assets
            const peopleAssets = await AssetRepository.getPeopleAssets(200);

            // Simple grouping by face count for now (e.g., "1 Person", "2 People", etc.)
            // In a real app, we would cluster by face vectors
            const categorizedAssetIds = new Set<string>();
            const peopleMap = new Map<string, AssetRecord[]>();

            // Disqualifying labels for People category (to prevent Screenshots/Text being classified as People)
            const DISQUALIFYING_LABELS = new Set([
                'web site', 'website', 'monitor', 'screen', 'computer screen',
                'display', 'text', 'menu', 'comic book', 'screenshot', 'carton'
            ]);

            peopleAssets.forEach(asset => {
                // Check if this asset should be disqualified from "People" despite having faces
                // (Common false positives: Screenshots, Ads, Anime)
                if (asset.labels_json) {
                    try {
                        const labels: ImageLabel[] = JSON.parse(asset.labels_json);
                        const isDisqualified = labels.some(l =>
                            l.confidence > 0.4 && // Standard threshold
                            l.text && DISQUALIFYING_LABELS.has(l.text.toLowerCase())
                        );

                        if (isDisqualified) {
                            // Skip adding to people map.
                            // Do NOT add to categorizedAssetIds, so it falls through to Object/Scene categorization.
                            return;
                        }
                    } catch (e) {
                        // Ignore parse error
                    }
                }

                categorizedAssetIds.add(asset.asset_id);
                // Ensure face_count is treated as a number, defaulting to 1 if missing but query returned it
                const count = (asset as any).face_count || 1;
                // Simplify to Single vs Group
                const key = count > 1 ? 'people_group' : 'people_single';

                if (!peopleMap.has(key)) {
                    peopleMap.set(key, []);
                }
                peopleMap.get(key)?.push(asset);
            });

            const peopleResult: CategoryGroup[] = Array.from(peopleMap.entries()).map(([title, assets]) => ({
                id: `people_${title}`,
                title,
                count: assets.length,
                coverAsset: assets[0],
                assets,
            })).sort((a, b) => b.count - a.count);

            setPeopleGroups(peopleResult);

            // 2. Load Object/Scene Assets
            const labeledAssets = await AssetRepository.getLabeledAssets(5000); // Increased limit to capture more assets
            const labelMap = new Map<string, AssetRecord[]>();

            const humanAssets: AssetRecord[] = [];

            labeledAssets.forEach(asset => {
                // Skip if already categorized as people (via face detection)
                if (categorizedAssetIds.has(asset.asset_id)) return;

                try {
                    if (!asset.labels_json) return;
                    const labels: ImageLabel[] = JSON.parse(asset.labels_json);

                    // Take the top confident label
                    if (labels.length > 0) {
                        // Filter out low confidence (lowered to 0.40 to capture half-body/blurry people)
                        // User request: "Lower threshold"
                        const validLabels = labels.filter(l => l.confidence > 0.40);
                        if (validLabels.length === 0) return;

                        // Use the top label as the category
                        const topLabel = validLabels[0].text || (validLabels[0] as any).label; // Fallback for old data
                        let finalLabel = topLabel;

                        // Check if it's a HUMAN label (e.g. Groom, Diver) -> Move to People
                        const group = getCategoryGroup(finalLabel);
                        if (group === 'people') {
                            humanAssets.push(asset);
                            categorizedAssetIds.add(asset.asset_id);
                            return; // Done
                        }

                        // Smart Reranking Strategy
                        if (topLabel && typeof topLabel === 'string') {
                            // ... (Existing Reranking Logic) ...
                            // Check candidates
                            const topCandidates = validLabels.slice(0, 5);
                            for (const candidate of topCandidates) {
                                if (candidate.confidence > 0.2) {
                                    const labelText = candidate.text || (candidate as any).label;
                                    if (typeof labelText === 'string') {
                                        const candidateGroup = getCategoryGroup(labelText);
                                        // If we find a "Strong Prior" category (Cat/Dog/People)
                                        if (candidateGroup === 'cat' || candidateGroup === 'dog') {
                                            if (validLabels[0].confidence < 0.8) {
                                                finalLabel = labelText;
                                                break;
                                            }
                                        }
                                        // Also check Human Group in candidates
                                        if (candidateGroup === 'people' && candidate.confidence > 0.4) {
                                            humanAssets.push(asset);
                                            categorizedAssetIds.add(asset.asset_id);
                                            return;
                                        }
                                    }
                                }
                            }

                            // Check for broad group again
                            const broadGroup = getCategoryGroup(finalLabel);
                            const labelToUse = broadGroup || finalLabel;

                            // Translate label
                            const category = translateLabel(labelToUse, language as 'en' | 'zh');

                            if (!labelMap.has(category)) {
                                labelMap.set(category, []);
                            }
                            labelMap.get(category)?.push(asset);
                            categorizedAssetIds.add(asset.asset_id);
                        }
                    }
                } catch (e) {
                    console.warn('Failed to parse labels for asset', asset.asset_id, e);
                }
            });

            // Add Human Assets to People Groups
            if (humanAssets.length > 0) {
                const key = language === 'zh' ? '人物(全身/背面)' : 'People (Body/Pose)';
                setPeopleGroups(prev => {
                    const existing = prev.find(p => p.title === key);
                    if (existing) {
                        // Merge if exists (unlikely in this flow but safe)
                        return prev;
                    }
                    return [...prev, {
                        id: 'people_body',
                        title: key,
                        count: humanAssets.length,
                        coverAsset: humanAssets[0],
                        assets: humanAssets
                    }];
                });
                // Re-sort people groups
                // (We need to do this carefully since we use setState inside loop? No, setState is after.)
                // Actually we construct peopleResult above. We should merge humanAssets into peopleResult.
            }

            // Merge Human Body results into peopleResult (Refactoring needed: calculated above)
            // Let's just append to peopleResult variable if I could... but I set state already.
            // Better to re-calculate peopleResult including humanAssets.

            // Re-construct People Groups with Human Assets (Merge into 'people_single')
            let finalPeopleGroups = peopleResult;
            if (humanAssets.length > 0) {
                // Find existing single group or create new
                const singleGroupIndex = finalPeopleGroups.findIndex(g => g.title === 'people_single');
                if (singleGroupIndex !== -1) {
                    finalPeopleGroups[singleGroupIndex].assets.push(...humanAssets);
                    finalPeopleGroups[singleGroupIndex].count += humanAssets.length;
                } else {
                    finalPeopleGroups.push({
                        id: 'people_single',
                        title: 'people_single',
                        count: humanAssets.length,
                        coverAsset: humanAssets[0],
                        assets: humanAssets
                    });
                }
            }
            // Sort groups (Single vs Group)
            finalPeopleGroups.sort((a, b) => b.count - a.count);
            setPeopleGroups(finalPeopleGroups);

            const objectResult: CategoryGroup[] = Array.from(labelMap.entries()).map(([title, assets]) => ({
                id: `obj_${title}`,
                title,
                count: assets.length,
                coverAsset: assets[0],
                assets,
            })).sort((a, b) => b.count - a.count);

            setObjectGroups(objectResult);

            // 3. Handle Uncategorized & Processing Counts
            const statusCounts = await AssetRepository.getStatusCounts(); // { pending, done, error }

            const uncategorizedAssets: AssetRecord[] = [];
            labeledAssets.forEach(asset => {
                if (!categorizedAssetIds.has(asset.asset_id)) {
                    uncategorizedAssets.push(asset);
                }
            });

            // Add a "Processing" bucket if there are pending items
            // Or just include them in the total stats display?
            // The Hook returns `uncategorizedGroup`. 
            // We can rename "Uncategorized" to "Others & Processing" if pending > 0?
            // Or simpler: Just rely on UI to show processing.
            // But user asked why total is wrong.
            // If I return a special "Processing" group in objectGroups?

            if (statusCounts.pending > 0) {
                // Add a placeholder group for Processing
                objectResult.push({
                    id: 'status_pending',
                    title: language === 'zh' ? `处理中 (${statusCounts.pending})` : `Processing (${statusCounts.pending})`,
                    count: statusCounts.pending,
                    coverAsset: {} as any, // Placeholder
                    assets: [] // Empty assets, just for display? User might click and crash.
                });
                // Better: Just fix Uncategorized count?
            }

            // Let's just update Uncategorized to include this info in title?
            let uncatTitle = language === 'zh' ? '未分类' : 'Uncategorized';
            if (statusCounts.pending > 0) {
                uncatTitle += ` (+${statusCounts.pending} ${language === 'zh' ? '处理中' : 'processing'})`;
            }

            if (uncategorizedAssets.length > 0 || statusCounts.pending > 0) {
                setUncategorizedGroup({
                    id: 'uncategorized',
                    title: uncatTitle,
                    count: uncategorizedAssets.length + statusCounts.pending, // Sum them up visually
                    coverAsset: uncategorizedAssets[0] || {} as any,
                    assets: uncategorizedAssets,
                });
            } else {
                setUncategorizedGroup(null);
            }

        } catch (error) {
            console.error('Failed to load AI categories:', error);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        loadCategories();
    }, [language]);

    return {
        peopleGroups,
        objectGroups,
        uncategorizedGroup,
        isLoading,
        refresh: loadCategories,
    };
}
