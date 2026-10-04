import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Modal } from 'react-native';
import { PhotoPreviewModal } from '../../components/PhotoPreviewModal';

let mockReducedMotion = false;
jest.mock('react-native-reanimated', () => ({ useReducedMotion: () => mockReducedMotion }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 32, left: 0, right: 0 }) }));
jest.mock('../../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../hooks/useThemeColor', () => ({ useThemeColor: () => ({ colors: require('../../constants/theme').COLORS }) }));
jest.mock('../../hooks/usePhotoPreviewSource', () => ({ usePhotoPreviewSource: (uri: string) => ({ uri, loading: false, failed: false, attempt: 0 }) }));

it.each([false, true])('keeps preview dismissal explicit with reduced motion=%s', reduced => {
    mockReducedMotion = reduced;
    const onClose = jest.fn();
    const view = render(<PhotoPreviewModal photo={{ id: 'synthetic', uri: 'file:///synthetic.jpg' }} onClose={onClose} />);
    expect(view.UNSAFE_getByType(Modal).props.animationType).toBe(reduced ? 'none' : 'fade');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'close' }));
    act(() => view.UNSAFE_getByType(Modal).props.onRequestClose());
    expect(onClose).toHaveBeenCalledTimes(2);
});
