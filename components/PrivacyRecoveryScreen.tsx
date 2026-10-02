import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColor } from '../hooks/useThemeColor';
import { useI18n } from '../hooks/useI18n';
import { UI_METRICS } from '../constants/theme';

export function PrivacyRecoveryScreen({ failure, busy, onRetry }: {
    failure: 'read' | 'write' | null; busy: boolean; onRetry: () => void;
}) {
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const insets = useSafeAreaInsets();
    return <ScrollView contentContainerStyle={[styles.content, { backgroundColor: colors.background,
        paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32,
        paddingLeft: insets.left + UI_METRICS.pageInset, paddingRight: insets.right + UI_METRICS.pageInset }]}>
        <View style={styles.body}>
            {Platform.OS === 'web' ? <>
                <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('privacy_native_title')}</Text>
                <Text style={[styles.description, { color: colors.textSecondary }]}>{t('privacy_native_desc')}</Text>
            </> : !failure ? <ActivityIndicator color={colors.primary} accessibilityLabel={t('privacy_loading')} /> : <>
                <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t(failure === 'read' ? 'privacy_read_title' : 'privacy_write_title')}</Text>
                <Text style={[styles.description, { color: colors.textSecondary }]}>{t(failure === 'read' ? 'privacy_read_desc' : 'privacy_write_desc')}</Text>
                <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }}
                    disabled={busy} onPress={onRetry} style={({ pressed }) => [styles.button,
                        { backgroundColor: colors.actionBackground, opacity: pressed || busy ? 0.65 : 1 }]}>
                    <Text style={[styles.buttonText, { color: colors.actionForeground }]}>{t(busy ? 'privacy_retrying' : 'privacy_retry')}</Text>
                </Pressable>
            </>}
        </View>
    </ScrollView>;
}
const styles = StyleSheet.create({
    content: { flexGrow: 1, justifyContent: 'center' },
    body: { width: '100%', maxWidth: 480, alignSelf: 'center' },
    title: { fontSize: 24, fontWeight: '600', marginBottom: 16 },
    description: { fontSize: 15, lineHeight: 24, marginBottom: 32 },
    button: { minHeight: 52, paddingVertical: 15, paddingHorizontal: 24, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
    buttonText: { fontSize: 15, fontWeight: '600' },
});
