import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Modal, ScrollView } from 'react-native';
import zh from '../../i18n/zh';
import en from '../../i18n/en';

let mockLanguage: 'zh' | 'en' = 'zh';
jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 60, bottom: 24, left: 0, right: 0 }) }));
jest.mock('../../hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => (
    mockLanguage === 'zh' ? require('../../i18n/zh').default : require('../../i18n/en').default
  )[key] }),
}));
jest.mock('../../hooks/useThemeColor', () => ({
  useThemeColor: () => ({ colors: require('../../constants/theme').COLORS }),
}));

import { AIScanGuideModal } from '../../components/AIScanGuideModal';

describe('AI scan guide', () => {
  it.each(['zh', 'en'] as const)('directs %s users to the actual settings group and classification switch', language => {
    mockLanguage = language;
    const messages = language === 'zh' ? zh : en;
    const view = render(<AIScanGuideModal visible onStartScan={jest.fn()} onDismiss={jest.fn()} />);
    const hint = view.getByText(messages.ai_guide_classification_hint).props.children;
    expect(hint).toContain(messages.settings_intelligent_analysis);
    expect(hint).toContain(messages.settings_enable_ai_classification);
    expect(hint).not.toMatch(/开发者选项|Developer Options/i);
  });

  it('does not start a scan when dismissing the guide', () => {
    mockLanguage = 'zh';
    const onStartScan = jest.fn();
    const onDismiss = jest.fn();
    const view = render(<AIScanGuideModal visible onStartScan={onStartScan} onDismiss={onDismiss} />);
    fireEvent.press(view.getByText(zh.ai_guide_dismiss));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onStartScan).not.toHaveBeenCalled();
  });

  it('starts only through the explicit start action, not by rendering or system back', () => {
    mockLanguage = 'zh';
    const onStartScan = jest.fn();
    const onDismiss = jest.fn();
    const view = render(<AIScanGuideModal visible onStartScan={onStartScan} onDismiss={onDismiss} />);
    expect(onStartScan).not.toHaveBeenCalled();
    fireEvent(view.UNSAFE_getByType(Modal), 'requestClose');
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onStartScan).not.toHaveBeenCalled();
    fireEvent.press(view.getByText(zh.ai_guide_start));
    expect(onStartScan).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('provides explicitly named start and dismissal buttons', () => {
    mockLanguage = 'en';
    const view = render(<AIScanGuideModal visible onStartScan={jest.fn()} onDismiss={jest.fn()} />);
    expect(view.getByRole('button', { name: en.ai_guide_start })).toBeTruthy();
    expect(view.getByRole('button', { name: en.ai_guide_dismiss })).toBeTruthy();
  });

  it('keeps actions outside scrollable copy and lets explicit close dismiss without starting', () => {
    mockLanguage = 'zh';
    const onStartScan = jest.fn();
    const onDismiss = jest.fn();
    const view = render(<AIScanGuideModal visible onStartScan={onStartScan} onDismiss={onDismiss} />);
    const scroll = view.UNSAFE_getByType(ScrollView);
    expect(scroll.props.style).toMatchObject({ flexShrink: 1 });
    expect(scroll.findAll((node: { props: { onPress?: unknown } }) => node.props.onPress)).toHaveLength(0);
    expect(view.getByRole('button', { name: zh.ai_guide_start })).toHaveStyle({ minHeight: 50 });
    expect(view.getByTestId('sheet-backdrop', { includeHiddenElements: true }).props.onPress).toBeUndefined();
    fireEvent.press(view.getByRole('button', { name: zh.ai_guide_close }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onStartScan).not.toHaveBeenCalled();
  });
});
