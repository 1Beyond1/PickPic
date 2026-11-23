import React from 'react';
import { act, fireEvent, renderAsync, screen, waitFor } from '@testing-library/react-native';
import * as MediaLibrary from 'expo-media-library';

const mockScanExactDuplicates = jest.fn();
const mockFlushMediaProgress = jest.fn().mockResolvedValue(undefined);
const mockEnqueueWithReport = jest.fn();

const mockMediaState = {
    deleteQueue: [] as any[],
    videoTrashBin: [] as any[],
    pendingDeletionInfo: {},
    protectedAlbums: [{ albumId: 'alb-docs', title: 'Docs', createdAt: 1 }],
    protectedAssetIds: ['p-prot'],
    permissionRefreshVersion: 0,
    mediaLibraryRefreshVersion: 0,
    lastDeletionResult: null as any,
    hasHydrated: true,
    isConfirmingDeletion: false,
    isConfirmingVideoTrash: false,
    enqueuePendingDeletionWithReport: (...args: any[]) => mockEnqueueWithReport(...args),
    enqueuePendingDeletion: jest.fn(() => 0),
};

jest.mock('expo-media-library', () => ({
    getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, accessPrivileges: 'all' }),
    getAssetInfoAsync: jest.fn(),
    getAssetsAsync: jest.fn(),
    deleteAssetsAsync: jest.fn(),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../hooks/useI18n', () => ({
    useI18n: () => ({
        language: 'zh',
        t: (key: string, params: Record<string, string | number> = {}) => {
            let value = (require('../../i18n/zh').default as Record<string, string>)[key] ?? key;
            for (const [k, v] of Object.entries(params)) {
                value = value.replace(`{${k}}`, String(v));
            }
            return value;
        },
    }),
}));
jest.mock('../../hooks/useThemeColor', () => ({
    useThemeColor: () => ({ colors: require('../../constants/theme').COLORS, isDark: false }),
}));
jest.mock('../../services/exactDuplicates', () => {
    const actual = jest.requireActual('../../services/exactDuplicates');
    return {
        ...actual,
        scanExactDuplicatesFromIndexedPhotos: (...args: any[]) => mockScanExactDuplicates(...args),
    };
});
jest.mock('../../services/mediaProgressStorage', () => ({
    flushMediaProgress: (...args: any[]) => mockFlushMediaProgress(...args),
}));
jest.mock('../../services/readableMedia', () => ({
    getReadableMediaInfos: jest.fn(async (ids: string[]) => new Map(
        ids.map(id => [id, {
            id,
            uri: `file:///${id}.jpg`,
            localUri: `file:///${id}.jpg`,
            mediaType: 'photo',
            albumId: id === 'p-prot' ? 'alb-docs' : 'alb-cam',
        }]),
    )),
}));
jest.mock('../../stores/useMediaStore', () => ({
    useMediaStore: Object.assign((selector: any) => selector(mockMediaState), { getState: () => mockMediaState }),
}));
jest.mock('../../components/ZoomablePhotoModal', () => ({
    ZoomablePhotoModal: ({ visible, photo, testID }: any) => {
        const ReactModule = require('react');
        const { View, Text } = require('react-native');
        return visible && photo
            ? ReactModule.createElement(View, { testID }, ReactModule.createElement(Text, null, photo.id))
            : null;
    },
}));

import { ExactDuplicatesView } from '../../components/ExactDuplicatesView';

describe('ExactDuplicatesView UI workflow', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockMediaState.deleteQueue = [];
        mockEnqueueWithReport.mockImplementation((assets: any[]) => ({
            added: assets.length,
            alreadyQueued: 0,
            protectedSkipped: 0,
            protectedAssetIds: [],
        }));
    });

    it('detects byte-identical groups, locks protected copies as kept, opens zoom modal, and queues only unprotected copies without direct deletion', async () => {
        const digest = 'a1b2c3d4e5f6'.padEnd(64, '0');
        mockScanExactDuplicates.mockResolvedValue({
            status: 'ready',
            totalEvaluated: 5,
            sizeBucketCandidateCount: 3,
            hashedCount: 2,
            skippedUnknownSizeCount: 1,
            skippedUnreadableCount: 1,
            skippedOversizedCount: 0,
            permissionLimited: false,
            groups: [
                {
                    sha256: digest,
                    fileSize: 2 * 1024 * 1024,
                    members: [
                        {
                            assetId: 'p-copy',
                            uri: 'file:///p-copy.jpg',
                            fileSize: 2 * 1024 * 1024,
                            creationTime: 1700000000000,
                            albumId: 'alb-cam',
                            width: 4000,
                            height: 3000,
                            isProtected: false,
                        },
                        {
                            assetId: 'p-prot',
                            uri: 'file:///p-prot.jpg',
                            fileSize: 2 * 1024 * 1024,
                            creationTime: 1700000500000,
                            albumId: 'alb-docs',
                            width: 4000,
                            height: 3000,
                            isProtected: true,
                        },
                    ],
                    recommendedKeepIds: ['p-prot'],
                    reclaimableBytes: 2 * 1024 * 1024,
                },
            ],
        });

        await renderAsync(<ExactDuplicatesView completedCount={5} onOpenSettings={jest.fn()} />);

        await act(async () => {
            fireEvent.press(screen.getByTestId('exact-dup-start-btn'));
        });

        await waitFor(() => expect(screen.getByTestId('exact-dup-summary')).toBeTruthy());
        expect(screen.getByTestId('exact-dup-incomplete-warning')).toBeTruthy();
        expect(screen.getByTestId('exact-dup-protected-p-prot')).toBeTruthy();

        // Tapping protected item toggle keeps it locked and displays warning feedback.
        fireEvent.press(screen.getByTestId('exact-dup-toggle-p-prot'));
        expect(screen.getByTestId('exact-dup-feedback').props.children).toContain('保护相册已锁定保留');

        // Tapping thumbnail opens ZoomablePhotoModal.
        fireEvent.press(screen.getByTestId('exact-dup-preview-p-copy'));
        expect(screen.getByTestId('exact-dup-zoom-preview')).toBeTruthy();

        // One-tap batch queue sends ONLY unprotected copy to unified pending-deletion queue with source 'exact_duplicate'.
        await act(async () => {
            fireEvent.press(screen.getByTestId('exact-dup-batch-queue-btn'));
        });

        expect(mockEnqueueWithReport).toHaveBeenCalledTimes(1);
        expect(mockEnqueueWithReport).toHaveBeenCalledWith(
            [expect.objectContaining({ id: 'p-copy' })],
            'exact_duplicate',
        );
        expect(mockFlushMediaProgress).toHaveBeenCalledTimes(1);
        expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    });
});
