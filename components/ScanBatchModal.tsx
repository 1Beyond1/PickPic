/**
 * ScanBatchModal - Modal for selecting scan mode (by album or by count)
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { AlbumSelector } from './AlbumSelector';

interface ScanBatchModalProps {
    visible: boolean;
    onClose: () => void;
    onStartScan: (options: { mode: 'album' | 'count'; albumIds?: string[]; count?: number }) => void;
}

// Available count options
const COUNT_OPTIONS = [100, 200, 300, 500, 1000];

export function ScanBatchModal({ visible, onClose, onStartScan }: ScanBatchModalProps) {
    const { colors, isDark } = useThemeColor();
    const { t, language } = useI18n();

    const [mode, setMode] = useState<'album' | 'count' | null>(null);
    const [count, setCount] = useState(100);
    const [showAlbumSelector, setShowAlbumSelector] = useState(false);

    const handleStartByCount = () => {
        onStartScan({ mode: 'count', count });
        onClose();
        setMode(null);
    };

    const handleAlbumConfirm = (albumIds: string[]) => {
        setShowAlbumSelector(false);
        onStartScan({ mode: 'album', albumIds });
        onClose();
        setMode(null);
    };

    const handleSelectAlbum = () => {
        setShowAlbumSelector(true);
    };

    const resetAndClose = () => {
        setMode(null);
        onClose();
    };

    if (!visible) return null;

    return (
        <>
            <Modal
                visible={visible && !showAlbumSelector}
                transparent
                animationType="fade"
                onRequestClose={resetAndClose}
            >
                <View style={styles.overlay}>
                    <View style={[styles.modal, { backgroundColor: colors.surface }]}>
                        <Text style={[styles.title, { color: colors.text }]}>
                            {t('scan_batch' as any)}
                        </Text>

                        {mode === null ? (
                            // Mode Selection
                            <View style={styles.optionsContainer}>
                                <Pressable
                                    style={[styles.optionButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : '#F5F5F5' }]}
                                    onPress={handleSelectAlbum}
                                >
                                    <Ionicons name="albums" size={24} color={colors.primary} />
                                    <Text style={[styles.optionText, { color: colors.text }]}>
                                        {t('scan_batch_by_album' as any)}
                                    </Text>
                                    <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
                                </Pressable>

                                <Pressable
                                    style={[styles.optionButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : '#F5F5F5' }]}
                                    onPress={() => setMode('count')}
                                >
                                    <Ionicons name="calculator" size={24} color={colors.primary} />
                                    <Text style={[styles.optionText, { color: colors.text }]}>
                                        {t('scan_batch_by_count' as any)}
                                    </Text>
                                    <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
                                </Pressable>
                            </View>
                        ) : mode === 'count' ? (
                            // Count Selection with Buttons
                            <View style={styles.countContainer}>
                                <Text style={[styles.countLabel, { color: colors.primary }]}>
                                    {t('scan_batch_count_label' as any, { count })}
                                </Text>

                                {/* Count Options Grid */}
                                <ScrollView
                                    horizontal
                                    showsHorizontalScrollIndicator={false}
                                    contentContainerStyle={styles.countOptionsContainer}
                                >
                                    {COUNT_OPTIONS.map((option) => (
                                        <Pressable
                                            key={option}
                                            style={[
                                                styles.countOption,
                                                {
                                                    backgroundColor: count === option
                                                        ? colors.primary
                                                        : isDark ? 'rgba(255,255,255,0.1)' : '#F0F0F0',
                                                    borderColor: count === option ? colors.primary : 'transparent',
                                                }
                                            ]}
                                            onPress={() => setCount(option)}
                                        >
                                            <Text style={[
                                                styles.countOptionText,
                                                { color: count === option ? '#FFF' : colors.text }
                                            ]}>
                                                {option}
                                            </Text>
                                        </Pressable>
                                    ))}
                                </ScrollView>

                                <Pressable
                                    style={[styles.startButton, { backgroundColor: colors.primary }]}
                                    onPress={handleStartByCount}
                                >
                                    <Text style={styles.startButtonText}>
                                        {t('scan_batch_start' as any)}
                                    </Text>
                                </Pressable>

                                <Pressable
                                    style={[styles.backButton]}
                                    onPress={() => setMode(null)}
                                >
                                    <Ionicons name="arrow-back" size={16} color={colors.textSecondary} />
                                    <Text style={[styles.backButtonText, { color: colors.textSecondary }]}>
                                        {language === 'zh' ? '返回' : 'Back'}
                                    </Text>
                                </Pressable>
                            </View>
                        ) : null}

                        {/* Close Button */}
                        {mode === null && (
                            <Pressable style={styles.cancelButton} onPress={resetAndClose}>
                                <Text style={[styles.cancelText, { color: colors.textSecondary }]}>
                                    {t('cancel')}
                                </Text>
                            </Pressable>
                        )}
                    </View>
                </View>
            </Modal>

            {/* Album Selector */}
            <AlbumSelector
                visible={showAlbumSelector}
                onClose={() => setShowAlbumSelector(false)}
                onConfirm={handleAlbumConfirm}
                initialSelection={[]}
            />
        </>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    modal: {
        width: '85%',
        borderRadius: 20,
        padding: 24,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        elevation: 8,
    },
    title: {
        fontSize: 20,
        fontWeight: 'bold',
        textAlign: 'center',
        marginBottom: 20,
    },
    optionsContainer: {
        gap: 12,
    },
    optionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        borderRadius: 14,
        gap: 12,
    },
    optionText: {
        flex: 1,
        fontSize: 16,
        fontWeight: '500',
    },
    countContainer: {
        alignItems: 'center',
    },
    countLabel: {
        fontSize: 32,
        fontWeight: 'bold',
        marginBottom: 20,
    },
    countOptionsContainer: {
        flexDirection: 'row',
        gap: 10,
        paddingHorizontal: 4,
    },
    countOption: {
        paddingVertical: 12,
        paddingHorizontal: 20,
        borderRadius: 12,
        borderWidth: 2,
        minWidth: 70,
        alignItems: 'center',
    },
    countOptionText: {
        fontSize: 16,
        fontWeight: '600',
    },
    startButton: {
        marginTop: 24,
        paddingVertical: 14,
        paddingHorizontal: 40,
        borderRadius: 14,
    },
    startButtonText: {
        color: '#FFF',
        fontSize: 16,
        fontWeight: '600',
    },
    backButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 16,
        gap: 4,
    },
    backButtonText: {
        fontSize: 14,
    },
    cancelButton: {
        marginTop: 16,
        alignItems: 'center',
    },
    cancelText: {
        fontSize: 15,
    },
});
