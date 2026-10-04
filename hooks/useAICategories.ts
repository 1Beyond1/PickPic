import * as MediaLibrary from 'expo-media-library';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AssetRecord, AssetRepository } from '../database';
import { selectImageCategories } from '../services/ml/LabelClassifier';
import { AlbumCategory, categoryTitle } from '../services/ml/CategoryGrouper';
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
            resolveWithFullInfo: false,
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
    hasError: boolean;
    completedCount: number | null;
    refresh: () => Promise<void>;
}

export function useAICategories(enabled = true): AICategoriesState {
    const { language } = useI18n();
    const [peopleGroups, setPeopleGroups] = useState<CategoryGroup[]>([]);
    const [objectGroups, setObjectGroups] = useState<CategoryGroup[]>([]);
    const [uncategorizedGroup, setUncategorizedGroup] = useState<CategoryGroup | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [hasError, setHasError] = useState(false);
    const [completedCount, setCompletedCount] = useState<number | null>(null);
    const loadRequestIdRef = useRef(0);

    const loadCategories = useCallback(async () => {
        const requestId = ++loadRequestIdRef.current;
        setIsLoading(true);
        setHasError(false);
        setCompletedCount(null);
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
            const categorizedAssetIds = new Set<string>();
            const categoryAssets = new Map<AlbumCategory, AssetRecord[]>();
            for (const asset of labeledAssets) {
                let labels: unknown[] = [];
                if (asset.labels_json) {
                    try {
                        const parsed: unknown = JSON.parse(asset.labels_json);
                        if (Array.isArray(parsed)) labels = parsed;
                    } catch {
                        // Malformed historical labels remain unclassified. Never
                        // log identifiers, paths, labels or the stored payload.
                    }
                }
                for (const category of selectImageCategories(labels, asset.face_count ?? 0)) {
                    const items = categoryAssets.get(category) ?? [];
                    items.push(asset);
                    categoryAssets.set(category, items);
                    categorizedAssetIds.add(asset.asset_id);
                }
            }
            const groups: CategoryGroup[] = [...categoryAssets.entries()].map(([category, assets]) => ({
                id: `category_${category}`,
                title: categoryTitle(category, language),
                count: assets.length,
                coverAsset: assets[0],
                assets,
            })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
            const finalPeopleGroups = groups.filter(group => group.id === 'category_people');
            const objectResult = groups.filter(group => group.id !== 'category_people');

            // Count media once even when independent evidence gives two tags.
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

            setCompletedCount(labeledAssets.length);
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
            console.error('[AICategories] Failed to load saved categories.');
            if (requestId === loadRequestIdRef.current) setHasError(true);
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
            setHasError(false);
            setCompletedCount(null);
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
        hasError,
        completedCount,
        refresh: loadCategories,
    };
}
