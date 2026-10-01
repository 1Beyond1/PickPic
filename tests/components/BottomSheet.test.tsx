import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Modal, Text } from 'react-native';
import { BottomSheet } from '../../components/BottomSheet';

let mockDark = false;
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
