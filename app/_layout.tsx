import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AIScanGuideModal } from '../components/AIScanGuideModal';
import { AnnouncementModal } from '../components/AnnouncementModal';
import { MLBridge } from '../components/MLBridge';
import { COLORS } from '../constants/theme';
import { start as startScanner } from '../services/scanner';
import { useMediaStore } from '../stores/useMediaStore';
import { useScannerStore } from '../stores/useScannerStore';
import { APP_VERSION, useSettingsStore } from '../stores/useSettingsStore';

// Keep splash screen visible while loading
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { dismissedAnnouncementVersion, dismissAnnouncement, aiGuideShownVersion, dismissAIGuide } = useSettingsStore();
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [showAIGuide, setShowAIGuide] = useState(false);
  const [appReady, setAppReady] = useState(false);

  // Initialize app
  useEffect(() => {
    async function initializeApp() {
      // Refresh media counts on app start
      await useMediaStore.getState().refreshTotalCounts();
      setAppReady(true);
      SplashScreen.hideAsync();
    }
    initializeApp();
  }, []);

  // Show announcement first, then AI guide
  // Show announcement first, then AI guide (Check ONLY once on startup)
  const initialCheckDone = useRef(false);

  useEffect(() => {
    if (!appReady || initialCheckDone.current) return;

    initialCheckDone.current = true;

    // Priority 1: Show announcement if not dismissed
    if (dismissedAnnouncementVersion !== APP_VERSION) {
      const timer = setTimeout(() => {
        setShowAnnouncement(true);
      }, 500);
      return () => clearTimeout(timer);
    } else if (aiGuideShownVersion !== APP_VERSION) {
      // Priority 2: Show AI guide if announcement dismissed
      const timer = setTimeout(() => {
        setShowAIGuide(true);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [appReady]); // Remove dependencies on store versions so it doesn't re-run on reset

  const handleDismissOnce = () => {
    setShowAnnouncement(false);
    // After closing announcement, check if AI guide should show
    if (aiGuideShownVersion !== APP_VERSION) {
      setTimeout(() => setShowAIGuide(true), 300);
    }
  };

  const handleDismissForVersion = () => {
    setShowAnnouncement(false);
    dismissAnnouncement(APP_VERSION);
    // After dismissing announcement for version, check if AI guide should show
    if (aiGuideShownVersion !== APP_VERSION) {
      setTimeout(() => setShowAIGuide(true), 300);
    }
  };

  const handleAIGuideStart = () => {
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
      <MLBridge />
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
