import { Tabs } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { LiquidFloatingTabBar } from '../../components/LiquidFloatingTabBar';
import { useThemeColor } from '../../hooks/useThemeColor';

export default function TabLayout() {
  const { colors } = useThemeColor();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: { display: 'none' }, // Hide default tab bar
        }}
      >
        <Tabs.Screen name="photos" />
        <Tabs.Screen name="videos" />
        <Tabs.Screen name="scanResults" />
        <Tabs.Screen name="settings" />
      </Tabs>

      {/* Custom Floating Tab Bar */}
      <LiquidFloatingTabBar />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  }
});
