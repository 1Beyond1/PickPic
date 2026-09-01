import * as MediaLibrary from 'expo-media-library';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AssetRecord, AssetRepository } from '../database';
import { getCategoryGroup } from '../services/ml/CategoryGrouper';
import { translateLabel } from '../services/ml/LabelTranslator';
import { ImageLabel } from '../services/ml/MLKitService';
import { useI18n } from './useI18n';

const MEDIA_PAGE_SIZE = 100;

/**
 * Return the assets currently visible to the app when the OS grants only a
 * limited photo selection. A null result means the app has full access, so
 * callers can keep the cheaper database-only path.
 */
async function getLimitedPhotoIds(): Promise<ReadonlySet<string> | null> {
    const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
    if (!permission.granted) return new Set();
    if (permission.accessPrivileges !== 'limited') return null;

    const visibleIds = new Set<string>();
    let after: string | undefined;

    while (true) {
        const result = await MediaLibrary.getAssetsAsync({
            mediaType: 'photo',
            first: MEDIA_PAGE_SIZE,
            ...(after ? { after } : {}),
        });

        for (const asset of result.assets) {
            visibleIds.add(asset.id);
        }

        if (!result.hasNextPage) break;
        if (!result.endCursor || result.endCursor === after) {
            throw new Error('Media library returned an invalid pagination cursor for limited photo access');
        }
        after = result.endCursor;
    }

    return visibleIds;
}

export interface CategoryGroup {
    id: string;
    title: string;
    count: number;
    coverAsset: AssetRecord | null;
    assets: AssetRecord[];
}

export interface AICategoriesState {
    peopleGroups: CategoryGroup[];
    objectGroups: CategoryGroup[];
    uncategorizedGroup: CategoryGroup | null;
    isLoading: boolean;
    refresh: () => Promise<void>;
}

export function useAICategories(enabled = true): AICategoriesState {
    const { language } = useI18n();
    const [peopleGroups, setPeopleGroups] = useState<CategoryGroup[]>([]);
    const [objectGroups, setObjectGroups] = useState<CategoryGroup[]>([]);
    const [uncategorizedGroup, setUncategorizedGroup] = useState<CategoryGroup | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const loadRequestIdRef = useRef(0);

    const loadCategories = useCallback(async () => {
        const requestId = ++loadRequestIdRef.current;
        setIsLoading(true);
        // Do not keep rendering a category snapshot while its permission
        // scope is being revalidated. A scope change can make every asset in
        // the previous snapshot inaccessible.
        setPeopleGroups([]);
        setObjectGroups([]);
        setUncategorizedGroup(null);
        try {
            // Read one completed-asset snapshot so people and object
            // categories use the same dataset and large libraries are not
            // silently truncated by separate hard limits.
            const [allLabeledAssets, visiblePhotoIds] = await Promise.all([
                AssetRepository.getAllDoneAssets(),
                getLimitedPhotoIds(),
            ]);
            const labeledAssets = visiblePhotoIds
                ? allLabeledAssets.filter(asset => visiblePhotoIds.has(asset.asset_id))
                : allLabeledAssets;
            const peopleAssets = labeledAssets.filter(asset => (asset.face_count ?? 0) > 0);

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
                // peopleAssets only contains assets with at least one face.
                const count = asset.face_count ?? 1;
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

            // 2. Load Object/Scene Assets from the same completed snapshot.
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

            const objectResult: CategoryGroup[] = Array.from(labelMap.entries()).map(([title, assets]) => ({
                id: `obj_${title}`,
                title,
                count: assets.length,
                coverAsset: assets[0],
                assets,
            })).sort((a, b) => b.count - a.count);

            // 3. Handle Uncategorized & Processing Counts
            const statusCounts = await AssetRepository.getStatusCounts(
                visiblePhotoIds ? Array.from(visiblePhotoIds) : undefined
            ); // { pending, done, error }

            const uncategorizedAssets: AssetRecord[] = [];
            labeledAssets.forEach(asset => {
                if (!categorizedAssetIds.has(asset.asset_id)) {
                    uncategorizedAssets.push(asset);
                }
            });

            // Include pending work in the uncategorized summary. It does not
            // have a cover asset of its own, so the UI renders it as a
            // non-clickable placeholder instead of passing an invalid ID.
            let uncatTitle = language === 'zh' ? '未分类' : 'Uncategorized';
            if (statusCounts.pending > 0) {
                uncatTitle += ` (+${statusCounts.pending} ${language === 'zh' ? '处理中' : 'processing'})`;
            }

            if (requestId !== loadRequestIdRef.current) return;

            setPeopleGroups(finalPeopleGroups);
            setObjectGroups(objectResult);

            if (uncategorizedAssets.length > 0 || statusCounts.pending > 0) {
                setUncategorizedGroup({
                    id: 'uncategorized',
                    title: uncatTitle,
                    count: uncategorizedAssets.length + statusCounts.pending, // Sum them up visually
                    coverAsset: uncategorizedAssets[0] || null,
                    assets: uncategorizedAssets,
                });
            } else {
                setUncategorizedGroup(null);
            }

        } catch (error) {
            console.error('Failed to load AI categories:', error);
        } finally {
            if (requestId === loadRequestIdRef.current) {
                setIsLoading(false);
            }
        }
    }, [language]);

    useEffect(() => {
        if (!enabled) {
            loadRequestIdRef.current += 1;
            setPeopleGroups([]);
            setObjectGroups([]);
            setUncategorizedGroup(null);
            setIsLoading(false);
            return;
        }

        // The screen owns refresh timing so focus changes can refresh an
        // already-open AI tab without issuing a duplicate load when `enabled`
        // changes. Keep the loading state honest while that refresh starts.
        setIsLoading(true);
    }, [enabled]);

    return {
        peopleGroups,
        objectGroups,
        uncategorizedGroup,
        isLoading,
        refresh: loadCategories,
    };
}
