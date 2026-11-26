import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Modal, Text } from 'react-native';
import { BottomSheet } from '../../components/BottomSheet';

let mockDark = false;
let mockReducedMotion = false;
jest.mock('react-native-reanimated', () => ({ useReducedMotion: () => mockReducedMotion }));
beforeEach(() => { mockReducedMotion = false; });
jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('../../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../hooks/useThemeColor', () => ({ useThemeColor: () => ({ colors: mockDark ? require('../../constants/theme').COLORS_DARK : require('../../constants/theme').COLORS }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 32, left: 0, right: 0 }) }));

it.each([false, true])('keeps complete header/footer and explicit cancel paths in either theme (dark=%s)', dark => {
    mockDark = dark;
    const onClose = jest.fn();
    const view = render(<BottomSheet visible title="Select Albums to Organize" onClose={onClose} footer={<Text>Confirm</Text>}><Text>Albums</Text></BottomSheet>);
    expect(screen.getByRole('header', { name: 'Select Albums to Organize' })).toHaveStyle({ flex: 1, minWidth: 0 });
    expect(screen.getByRole('button', { name: 'cancel' })).toHaveStyle({ width: 44, height: 44, flexShrink: 0 });
    expect(screen.getByText('Confirm')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.press(screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }));
    act(() => view.UNSAFE_getByType(Modal).props.onRequestClose());
    expect(onClose).toHaveBeenCalledTimes(3);
});

it('can preserve an inert onboarding backdrop while naming its explicit close path', () => {
    const onClose = jest.fn();
    const view = render(<BottomSheet visible title="Introduction" closeLabel="Close introduction" dismissOnBackdrop={false} onClose={onClose}><Text>Explanation</Text></BottomSheet>);
    expect(screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }).props.onPress).toBeUndefined();
    fireEvent.press(screen.getByRole('button', { name: 'Close introduction' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => view.UNSAFE_getByType(Modal).props.onRequestClose());
    expect(onClose).toHaveBeenCalledTimes(2);
});

it.each([false, true])('respects reduced motion without changing its explicit close action (reduced=%s)', reduced => {
    mockReducedMotion = reduced;
    const onClose = jest.fn();
    const view = render(<BottomSheet visible title="Appearance" onClose={onClose}><Text>Theme choices</Text></BottomSheet>);
    expect(view.UNSAFE_getByType(Modal).props.animationType).toBe(reduced ? 'none' : 'slide');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
});
