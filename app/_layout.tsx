import * as MediaLibrary from 'expo-media-library';
import { Stack, usePathname, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AIScanGuideModal } from '../components/AIScanGuideModal';
import { AnnouncementModal } from '../components/AnnouncementModal';
import { MLBridge } from '../components/MLBridge';
import { COLORS } from '../constants/theme';
import { isScanning, start as startScanner, stop as stopScanner } from '../services/scanner';
import { useMediaStore } from '../stores/useMediaStore';
import { useScannerStore } from '../stores/useScannerStore';
import { APP_VERSION, useSettingsStore } from '../stores/useSettingsStore';

// Keep splash screen visible while loading
void SplashScreen.preventAutoHideAsync().catch(error => {
  console.error('[RootLayout] Failed to keep splash screen visible:', error);
});

export default function RootLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const [mediaPermission, , getMediaPermission] = MediaLibrary.usePermissions({
    granularPermissions: ['photo', 'video'],
  });
  const {
    dismissedAnnouncementVersion,
    dismissAnnouncement,
    aiGuideShownVersion,
    dismissAIGuide,
    enableAIClassification,
    hasHydrated: settingsHydrated,
  } = useSettingsStore();
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [showAIGuide, setShowAIGuide] = useState(false);
  const [appReady, setAppReady] = useState(false);
  const mediaPermissionGrantedRef = useRef(false);
  const mediaPermissionScopeRef = useRef<'none' | 'limited' | 'full' | null>(null);
  const initialCheckDone = useRef(false);

  // Keep the ref synchronized when the hook publishes a new permission
  // snapshot. Do not assign it during render: an async refresh can already
  // have observed revocation while the hook still exposes its previous
  // snapshot, and an unrelated render would otherwise restore the stale
  // granted value before the next delayed onboarding callback runs.
  useEffect(() => {
    if (!mediaPermission) return;

    const currentScope = !mediaPermission.granted
      ? 'none'
      : mediaPermission.accessPrivileges === 'limited'
        ? 'limited'
        : 'full';
    const previousScope = mediaPermissionScopeRef.current;

    mediaPermissionGrantedRef.current = mediaPermission.granted;

    if (previousScope !== null && previousScope !== currentScope) {
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
        void mediaStore.loadVideos(50, displayOrder, selectedAlbumIds);
      }
    }

    mediaPermissionScopeRef.current = currentScope;
  }, [mediaPermission]);

  // Permissions can be revoked in system settings after the initial route
  // has already replaced the permission screen. Keep the gate active for
  // every route and send the user back when access is no longer granted.
  useEffect(() => {
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
          if (pathname !== '/') {
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
  }, [getMediaPermission, pathname, router]);

  // Initialize app
  useEffect(() => {
    let mounted = true;

    async function initializeApp() {
      try {
        // Refresh media counts on app start
        await useMediaStore.getState().refreshTotalCounts();
      } catch (error) {
        console.error('[RootLayout] Failed to initialize app data:', error);
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
    if (!appReady || !settingsHydrated || !mediaPermission?.granted || initialCheckDone.current) return;

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
    appReady,
    settingsHydrated,
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

  return (
    <GestureHandlerRootView style={styles.container}>
      {enableAIClassification && <MLBridge />}
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: COLORS.background },
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
    backgroundColor: COLORS.background,
  },
  loadingContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
});
