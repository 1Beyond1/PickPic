import * as MediaLibrary from 'expo-media-library';
import { Stack, usePathname, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AIScanGuideModal } from '../components/AIScanGuideModal';
import { AnnouncementModal } from '../components/AnnouncementModal';
import { PrivacyRecoveryScreen } from '../components/PrivacyRecoveryScreen';
import { MLBridge } from '../components/MLBridge';
import { useThemeColor } from '../hooks/useThemeColor';
import { AssetRepository, closeDatabase, getDatabase } from '../database';
import { flushMediaProgress } from '../services/mediaProgressStorage';
import { flushSettings } from '../services/privacy/settingsStorage';
import { clearLegacyMediaCache } from '../services/privacy/mediaCache';
import { LocalPrivacyError, usePrivacyStore } from '../stores/usePrivacyStore';
import { isScanning, start as startScanner, stop as stopScanner } from '../services/scanner';
import { useMediaStore } from '../stores/useMediaStore';
import { useScannerStore } from '../stores/useScannerStore';
import { APP_VERSION, useSettingsStore } from '../stores/useSettingsStore';

// Keep splash screen visible while loading
void SplashScreen.preventAutoHideAsync().catch(error => {
  console.error('[RootLayout] Failed to keep splash screen visible:', error);
});

export default function RootLayout() {
  const { colors, isDark } = useThemeColor();
  const router = useRouter();
  const pathname = usePathname();
  const privacyFailures = usePrivacyStore(state => state.failures);
  const mediaHydrated = useMediaStore(state => state.hasHydrated);
  const [privacyRetrying, setPrivacyRetrying] = useState(false);
  const [mediaPermission, , getMediaPermission] = MediaLibrary.usePermissions({
    // Keep the global gate scoped to the required photo workflow. Android
    // reports a combined request as denied when video is refused, even though
    // the photo feed and scanner can operate with photo access alone.
    granularPermissions: ['photo'],
  });
  const {
    dismissedAnnouncementVersion,
    dismissAnnouncement,
    aiGuideShownVersion,
    dismissAIGuide,
    enableAIClassification,
    setEnableAIClassification,
    hasHydrated: settingsHydrated,
  } = useSettingsStore();
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [showAIGuide, setShowAIGuide] = useState(false);
  const [appReady, setAppReady] = useState(false);
  const privacyReady = appReady && settingsHydrated && mediaHydrated && Object.keys(privacyFailures).length === 0;
  const mediaPermissionGrantedRef = useRef(false);
  const mediaPermissionScopeRef = useRef<'none' | 'limited' | 'full' | null>(null);
  const previousMediaPermissionRef = useRef<typeof mediaPermission>(null);
  const pathnameRef = useRef(pathname);
  const queueVisibilityInitializedRef = useRef(false);
  const initialCheckDone = useRef(false);

  // The ML Kit packages used by the scanner are native-only. Their web
  // model hook throws during render, so a persisted native setting must not
  // be allowed to mount the bridge on web.
  useEffect(() => {
    if (Platform.OS === 'web' && enableAIClassification) {
      setEnableAIClassification(false);
    }
  }, [enableAIClassification, setEnableAIClassification]);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  // Keep the ref synchronized when the hook publishes a new permission
  // snapshot. Do not assign it during render: an async refresh can already
  // have observed revocation while the hook still exposes its previous
  // snapshot, and an unrelated render would otherwise restore the stale
  // granted value before the next delayed onboarding callback runs.
  useEffect(() => {
    if (!privacyReady || !mediaPermission) return;

    const currentScope = !mediaPermission.granted
      ? 'none'
      : mediaPermission.accessPrivileges === 'limited'
        ? 'limited'
        : 'full';
    const previousScope = mediaPermissionScopeRef.current;
    const permissionSnapshotChanged = previousMediaPermissionRef.current !== mediaPermission;

    mediaPermissionGrantedRef.current = mediaPermission.granted;

    // Android 14 keeps the coarse privilege at `limited` when the user edits
    // the selected-photo set. The permission hook still publishes a new
    // response object, so treat a new limited snapshot as a media-scope
    // refresh even though the privilege string did not change.
    const limitedSelectionChanged = permissionSnapshotChanged
      && previousScope === 'limited'
      && currentScope === 'limited';
    const scopeChanged = previousScope !== null && previousScope !== currentScope;
    const mediaSnapshotChanged = scopeChanged || limitedSelectionChanged;

    if (previousScope !== null && mediaSnapshotChanged) {
      const mediaStore = useMediaStore.getState();
      mediaStore.clearLoadedMedia();

      if (isScanning()) {
        stopScanner();
      }

      if (currentScope !== 'none') {
        const { groupSize, displayOrder, selectedAlbumIds } = useSettingsStore.getState();
        void mediaStore.loadAlbums();
        void mediaStore.refreshTotalCounts();
        void mediaStore.loadPhotos(groupSize, displayOrder, selectedAlbumIds);
      }
    }

    const mediaStore = useMediaStore.getState();
    mediaStore.setPermissionScope(currentScope);
    if (!queueVisibilityInitializedRef.current || mediaSnapshotChanged) {
      mediaStore.refreshQueuedAssetVisibility(currentScope, 'photo');
      mediaStore.pruneUnavailableQueuedAssets(currentScope, 'photo');
      queueVisibilityInitializedRef.current = true;
    }
    if (scopeChanged) {
      mediaStore.notifyPermissionRefresh();
    } else if (limitedSelectionChanged) {
      mediaStore.notifyMediaLibraryRefresh();
    }
    previousMediaPermissionRef.current = mediaPermission;
    mediaPermissionScopeRef.current = currentScope;
  }, [privacyReady, mediaPermission]);

  useEffect(() => {
    if (!privacyReady && isScanning()) stopScanner();
  }, [privacyReady]);

  // Permissions can be revoked in system settings after the initial route
  // has already replaced the permission screen. Keep the gate active for
  // every route and send the user back when access is no longer granted.
  useEffect(() => {
    // The recovery/loading screen deliberately does not mount routes. Do not
    // navigate or subscribe until protected state has opened successfully.
    if (!privacyReady) return;
    let mounted = true;

    const redirectIfPermissionRevoked = async () => {
      try {
        const permission = await getMediaPermission();
        if (mounted && !permission.granted) {
          mediaPermissionGrantedRef.current = false;
          initialCheckDone.current = false;
          setShowAnnouncement(false);
          setShowAIGuide(false);
          if (isScanning()) {
            stopScanner();
          }
          if (pathnameRef.current !== '/') {
            router.replace('/');
          }
        } else if (mounted) {
          mediaPermissionGrantedRef.current = permission.granted;
        }
      } catch (error) {
        console.error('[RootLayout] Failed to refresh media permission:', error);
      }
    };

    void redirectIfPermissionRevoked();
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        void redirectIfPermissionRevoked();
      }
    });

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [privacyReady, getMediaPermission, router]);

  // MediaLibrary reports both ordinary asset changes and iOS changes to the
  // selected subset while the permission remains `limited`. The privilege
  // string alone cannot distinguish the latter event, so refresh the visible
  // media state and notify result/detail screens explicitly. Web has no native
  // listener.
  useEffect(() => {
    if (!privacyReady || Platform.OS === 'web') return;

    const subscription = MediaLibrary.addListener(event => {
      if (Object.keys(usePrivacyStore.getState().failures).length) return;
      const isPermissionScopeChange = event.hasIncrementalChanges === false;
      const isIncrementalMediaChange = event.hasIncrementalChanges === true || Platform.OS === 'android';
      if (!isPermissionScopeChange && !isIncrementalMediaChange) return;

      const mediaStore = useMediaStore.getState();
      mediaStore.clearLoadedMedia();
      let indexCleanupPromise: Promise<void> | null = null;
      if (isPermissionScopeChange) {
        // The permission hook has not necessarily published the new scope
        // yet. Hide all persisted queue items until it does so.
        mediaStore.refreshQueuedAssetVisibility('none', 'photo');
        mediaStore.notifyPermissionRefresh();
      } else {
        const deletedAssetIds = event.deletedAssets?.map(asset => asset.id) ?? [];
        if (deletedAssetIds.length > 0) {
          // Incremental deletion events identify media that is genuinely gone.
          // Permission-scope changes use hasIncrementalChanges=false and must
          // not remove progress that may become visible again later.
          mediaStore.removeDeletedAssets(deletedAssetIds);
          indexCleanupPromise = AssetRepository.removeAssetsAndDerivedData(deletedAssetIds)
            .catch(() => {
              // The media is already gone. Keep the UI refresh, and let the
              // next complete scan repair the index if this cleanup failed.
              console.error('[RootLayout] Failed to clean externally deleted assets from scan index.');
            });
        }
        mediaStore.refreshQueuedAssetVisibility(mediaPermissionScopeRef.current ?? 'none', 'photo');
        mediaStore.pruneUnavailableQueuedAssets(mediaPermissionScopeRef.current ?? 'none', 'photo');
        if (!indexCleanupPromise) {
          mediaStore.notifyMediaLibraryRefresh();
        }
      }
      if (isScanning()) {
        stopScanner();
      }

      if (mediaPermissionGrantedRef.current) {
        const { groupSize, displayOrder, selectedAlbumIds } = useSettingsStore.getState();
        void mediaStore.loadAlbums();
        void mediaStore.refreshTotalCounts();
        void mediaStore.loadPhotos(groupSize, displayOrder, selectedAlbumIds);
      }

      if (indexCleanupPromise) {
        void indexCleanupPromise.then(() => {
          // Refresh scanner status only after the index transaction has
          // committed, otherwise deleted rows can be reported once more.
          useMediaStore.getState().notifyMediaLibraryRefresh();
        });
      }

      if (isPermissionScopeChange) {
        void getMediaPermission()
          .then(permission => {
            // A limited-to-limited selection change keeps the same coarse
            // privilege string, so the permission hook may not publish a
            // changed value. Apply the refreshed scope here as well, or the
            // conservative hidden-queue snapshot above would never resolve.
            const refreshedScope = !permission.granted
              ? 'none'
              : permission.accessPrivileges === 'limited'
                ? 'limited'
                : 'full';
            mediaPermissionGrantedRef.current = permission.granted;
            mediaPermissionScopeRef.current = refreshedScope;
            const refreshedStore = useMediaStore.getState();
            refreshedStore.setPermissionScope(refreshedScope);
            refreshedStore.refreshQueuedAssetVisibility(refreshedScope, 'photo');
            refreshedStore.pruneUnavailableQueuedAssets(refreshedScope, 'photo');
          })
          .catch(error => {
            console.error('[RootLayout] Failed to refresh permission after media-library scope change:', error);
          });
      }
    });

    return () => subscription.remove();
  }, [privacyReady, getMediaPermission]);

  // Initialize app
  useEffect(() => {
    let mounted = true;

    async function initializeApp() {
      try {
        await clearLegacyMediaCache();
        await getDatabase(); // Migrate/validate the protected scanner index before showing the app.
        // Refresh media counts on app start
        await useMediaStore.getState().refreshTotalCounts();
      } catch {
        // Native storage errors can contain SQL, identifiers or paths.
        // The protected database reports only a generic recovery state.
      } finally {
        if (mounted) {
          setAppReady(true);
        }

        try {
          await SplashScreen.hideAsync();
        } catch (error) {
          console.error('[RootLayout] Failed to hide splash screen:', error);
        }
      }
    }

    void initializeApp();
    return () => {
      mounted = false;
    };
  }, []);

  // Show announcement first, then AI guide
  // Show announcement first, then AI guide (Check ONLY once on startup)
  useEffect(() => {
    // Do not cover the permission gate with onboarding. On a fresh install
    // the user must grant media access before the AI guide can start a scan.
    if (!privacyReady || !mediaPermission?.granted || initialCheckDone.current) return;

    initialCheckDone.current = true;

    // Priority 1: Show announcement if not dismissed
    if (dismissedAnnouncementVersion !== APP_VERSION) {
      const timer = setTimeout(() => {
        if (mediaPermissionGrantedRef.current) setShowAnnouncement(true);
      }, 500);
      return () => clearTimeout(timer);
    } else if (aiGuideShownVersion !== APP_VERSION) {
      // Priority 2: Show AI guide if announcement dismissed
      const timer = setTimeout(() => {
        if (mediaPermissionGrantedRef.current) setShowAIGuide(true);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [
    privacyReady,
    mediaPermission?.granted,
    dismissedAnnouncementVersion,
    aiGuideShownVersion,
  ]);

  const handleDismissOnce = () => {
    setShowAnnouncement(false);
    // After closing announcement, check if AI guide should show
    if (aiGuideShownVersion !== APP_VERSION && mediaPermissionGrantedRef.current) {
      setTimeout(() => {
        if (mediaPermissionGrantedRef.current) setShowAIGuide(true);
      }, 300);
    }
  };

  const handleDismissForVersion = () => {
    setShowAnnouncement(false);
    dismissAnnouncement(APP_VERSION);
    // After dismissing announcement for version, check if AI guide should show
    if (aiGuideShownVersion !== APP_VERSION && mediaPermissionGrantedRef.current) {
      setTimeout(() => {
        if (mediaPermissionGrantedRef.current) setShowAIGuide(true);
      }, 300);
    }
  };

  const handleAIGuideStart = () => {
    if (!mediaPermissionGrantedRef.current) {
      setShowAIGuide(false);
      return;
    }
    setShowAIGuide(false);
    dismissAIGuide(APP_VERSION);
    // Start AI scanning in background
    useScannerStore.getState().setLastError(null);
    startScanner();
  };

  const handleAIGuideDismiss = () => {
    setShowAIGuide(false);
    dismissAIGuide(APP_VERSION);
  };

  const retryPrivacy = async () => {
    if (privacyRetrying) return;
    setPrivacyRetrying(true);
    try {
      if (isScanning()) {
        stopScanner();
        const deadline = Date.now() + 20000;
        while (isScanning() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
        if (isScanning()) throw new LocalPrivacyError();
      }
      await clearLegacyMediaCache();
      const failures = usePrivacyStore.getState().failures;
      if (failures.settings === 'read') await useSettingsStore.persist.rehydrate();
      else await flushSettings();
      if (failures.records === 'read') await useMediaStore.persist.rehydrate();
      else await flushMediaProgress();
      if (failures.scanner) await closeDatabase();
      await getDatabase();
    } catch {
      // The privacy gate retains the data and a non-sensitive failure state.
    } finally { setPrivacyRetrying(false); }
  };

  const failureKinds = Object.values(privacyFailures);
  if (!privacyReady) {
    const failure = failureKinds.includes('read') ? 'read' : failureKinds.length ? 'write' : null;
    return <GestureHandlerRootView style={[styles.container, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <PrivacyRecoveryScreen failure={failure} busy={privacyRetrying} onRetry={() => { void retryPrivacy(); }} />
    </GestureHandlerRootView>;
  }

  return (
    <GestureHandlerRootView style={[styles.container, { backgroundColor: colors.background }]}>
      {enableAIClassification && Platform.OS !== 'web' && <MLBridge />}
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'fade',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
      </Stack>

      <AnnouncementModal
        visible={showAnnouncement}
        onDismissOnce={handleDismissOnce}
        onDismissForVersion={handleDismissForVersion}
      />

      <AIScanGuideModal
        visible={showAIGuide}
        onStartScan={handleAIGuideStart}
        onDismiss={handleAIGuideDismiss}
      />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
});
