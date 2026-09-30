import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import zh from '../../i18n/zh';
import en from '../../i18n/en';

let mockLanguage: 'zh' | 'en' = 'zh';
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
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
});
