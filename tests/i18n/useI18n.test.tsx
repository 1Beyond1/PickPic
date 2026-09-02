jest.mock('../../stores/useSettingsStore', () => ({
  useSettingsStore: (selector: (state: { language: string }) => unknown) => (
    selector({ language: 'not-a-language' })
  ),
}));

import { renderHook } from '@testing-library/react-native';
import { useI18n } from '../../hooks/useI18n';

describe('useI18n', () => {
  it('falls back to Chinese for an invalid persisted language', () => {
    const { result } = renderHook(() => useI18n());

    expect(result.current.language).toBe('zh');
    expect(result.current.t('settings_language')).toBe('语言');
  });
});
