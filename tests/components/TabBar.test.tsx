import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { LiquidFloatingTabBar } from '../../components/LiquidFloatingTabBar';

const mockNavigate = jest.fn();
let mockPath = '/photos';
jest.mock('expo-router', () => ({
    useRouter: () => ({ navigate: mockNavigate }),
    usePathname: () => mockPath,
}));
jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 24 }) }));
jest.mock('../../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../hooks/useThemeColor', () => ({
    useThemeColor: () => ({ colors: require('../../constants/theme').COLORS }),
}));
jest.mock('react-native-reanimated', () => ({
    __esModule: true,
    default: { View: require('react-native').View },
    useSharedValue: (value: number) => ({ value }),
    useAnimatedStyle: (callback: () => unknown) => callback(),
    withTiming: (value: number) => value,
    runOnJS: (callback: unknown) => callback,
}));
jest.mock('react-native-gesture-handler', () => ({
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    Gesture: { Pan: () => {
        const pan = { onStart: () => pan, onUpdate: () => pan, onEnd: () => pan };
        return pan;
    } },
}));

describe('primary dock navigation', () => {
    beforeEach(() => { mockPath = '/photos'; mockNavigate.mockClear(); });

    it('keeps all four destinations, including the sole settings entry, reachable', () => {
        render(<LiquidFloatingTabBar />);
        expect(screen.getAllByRole('tab')).toHaveLength(4);
        fireEvent.press(screen.getByRole('tab', { name: 'tab_settings' }));
        expect(mockNavigate).toHaveBeenCalledWith('/(tabs)/settings');
        fireEvent.press(screen.getByRole('tab', { name: 'tab_videos' }));
        expect(mockNavigate).toHaveBeenCalledWith('/(tabs)/videos');
        fireEvent.press(screen.getByRole('tab', { name: 'tab_scan_results' }));
        expect(mockNavigate).toHaveBeenCalledWith('/(tabs)/scanResults');
    });

    it('marks the current destination and does not navigate again when pressed', () => {
        mockPath = '/settings';
        render(<LiquidFloatingTabBar />);
        const settings = screen.getByRole('tab', { name: 'tab_settings', selected: true });
        fireEvent.press(settings);
        expect(mockNavigate).not.toHaveBeenCalled();
    });
});
