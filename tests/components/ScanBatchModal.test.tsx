import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, Modal } from 'react-native';
import { ScanBatchModal } from '../../components/ScanBatchModal';

let mockDark = false;
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, Feather: () => null }));
jest.mock('../../hooks/useThemeColor', () => ({ useThemeColor: () => ({ colors: mockDark ? require('../../constants/theme').COLORS_DARK : require('../../constants/theme').COLORS, isDark: mockDark }) }));
jest.mock('../../hooks/useI18n', () => ({ useI18n: () => ({ language: 'en', t: (key: string, params?: { count: number }) => key === 'scan_batch_count_label' ? `${params?.count} photos` : key }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 32, left: 0, right: 0 }) }));
jest.mock('../../components/AlbumSelector', () => {
    const { Pressable, Text } = require('react-native');
    return { AlbumSelector: ({ visible, onClose, onConfirm }: any) => visible ? <>
        <Text>album-picker</Text>
        <Pressable onPress={onClose}><Text>cancel-albums</Text></Pressable>
        <Pressable onPress={() => onConfirm([])}><Text>empty-albums</Text></Pressable>
        <Pressable onPress={() => onConfirm(['album-one'])}><Text>confirm-albums</Text></Pressable>
    </> : null };
});

afterEach(() => jest.restoreAllMocks());

it.each([false, true])('starts only the explicitly chosen count in either theme (dark=%s)', dark => {
    mockDark = dark;
    const onStartScan = jest.fn();
    const onClose = jest.fn();
    render(<ScanBatchModal visible onClose={onClose} onStartScan={onStartScan} />);
    fireEvent.press(screen.getByText('scan_batch_by_count'));
    fireEvent.press(screen.getByText('500'));
    expect(onStartScan).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('scan_batch_start'));
    expect(onStartScan).toHaveBeenCalledTimes(1);
    expect(onStartScan).toHaveBeenCalledWith({ mode: 'count', count: 500 });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByText('scan_batch_by_album')).toBeTruthy();
});

it('returns from count selection without starting or closing the whole chooser', () => {
    const onStartScan = jest.fn();
    const onClose = jest.fn();
    render(<ScanBatchModal visible onClose={onClose} onStartScan={onStartScan} />);
    fireEvent.press(screen.getByText('scan_batch_by_count'));
    fireEvent.press(screen.getByText('Back'));
    expect(screen.getByText('scan_batch_by_album')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onStartScan).not.toHaveBeenCalled();
});

it('closes the count step with Android Back and returns to modes on reopening', () => {
    const onClose = jest.fn();
    const onStartScan = jest.fn();
    const view = render(<ScanBatchModal visible onClose={onClose} onStartScan={onStartScan} />);
    fireEvent.press(screen.getByText('scan_batch_by_count'));
    act(() => view.UNSAFE_getByType(Modal).props.onRequestClose());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStartScan).not.toHaveBeenCalled();
    view.rerender(<ScanBatchModal visible={false} onClose={onClose} onStartScan={onStartScan} />);
    view.rerender(<ScanBatchModal visible onClose={onClose} onStartScan={onStartScan} />);
    expect(screen.getByText('scan_batch_by_album')).toBeTruthy();
});

it('returns from the album picker on cancel, rejects empty albums and starts only confirmed IDs', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const onStartScan = jest.fn();
    const onClose = jest.fn();
    render(<ScanBatchModal visible onClose={onClose} onStartScan={onStartScan} />);
    fireEvent.press(screen.getByText('scan_batch_by_album'));
    fireEvent.press(screen.getByText('cancel-albums'));
    expect(screen.getByText('scan_batch_by_count')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onStartScan).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('scan_batch_by_album'));
    fireEvent.press(screen.getByText('empty-albums'));
    expect(alert).toHaveBeenCalledWith('scan_batch_album_required_title', 'scan_batch_album_required_message');
    expect(screen.getByText('album-picker')).toBeTruthy();
    expect(onStartScan).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('confirm-albums'));
    expect(onStartScan).toHaveBeenCalledTimes(1);
    expect(onStartScan).toHaveBeenCalledWith({ mode: 'album', albumIds: ['album-one'] });
    expect(onClose).toHaveBeenCalledTimes(1);
});

it.each(['close', 'scrim'] as const)('cancels count selection through %s without starting, with a readable selected quantity', method => {
    const onStartScan = jest.fn();
    const onClose = jest.fn();
    render(<ScanBatchModal visible onClose={onClose} onStartScan={onStartScan} />);
    fireEvent.press(screen.getByRole('button', { name: 'scan_batch_by_count' }));
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByRole('radio', { name: '100 photos' })).toBeChecked();
    fireEvent.press(screen.getByRole('radio', { name: '1000 photos' }));
    expect(screen.getByRole('radio', { name: '1000 photos' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '100 photos' })).not.toBeChecked();
    const close = screen.getByRole('button', { name: 'cancel' });
    expect(close).toHaveStyle({ width: 44, height: 44 });
    fireEvent.press(method === 'close' ? close : screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStartScan).not.toHaveBeenCalled();
    expect(screen.getByText('scan_batch_by_album')).toBeTruthy();
});
