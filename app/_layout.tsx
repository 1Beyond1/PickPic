import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AnnouncementModal } from '../components/AnnouncementModal';
import { COLORS } from '../constants/theme';
import { APP_VERSION, useSettingsStore } from '../stores/useSettingsStore';

// Keep splash screen visible while loading
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { dismissedAnnouncementVersion, dismissAnnouncement } = useSettingsStore();
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [appReady, setAppReady] = useState(false);

  // Initialize app
  useEffect(() => {
    async function initializeApp() {
      setAppReady(true);
      SplashScreen.hideAsync();
    }
    initializeApp();
  }, []);

  useEffect(() => {
    // Show announcement if it hasn't been dismissed for this version
    if (dismissedAnnouncementVersion !== APP_VERSION && appReady) {
      const timer = setTimeout(() => {
        setShowAnnouncement(true);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [dismissedAnnouncementVersion, appReady]);

  const handleDismissOnce = () => {
    setShowAnnouncement(false);
  };

  const handleDismissForVersion = () => {
    setShowAnnouncement(false);
    dismissAnnouncement(APP_VERSION);
  };

  return (
    <GestureHandlerRootView style={styles.container}>
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
