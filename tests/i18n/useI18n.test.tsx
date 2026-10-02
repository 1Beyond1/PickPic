jest.mock('../../stores/useSettingsStore', () => ({
  useSettingsStore: (selector: (state: { language: string }) => unknown) => (
    selector({ language: 'not-a-language' })
  ),
}));

import { renderHook } from '@testing-library/react-native';
import { useI18n } from '../../hooks/useI18n';
import en from '../../i18n/en';
import zh from '../../i18n/zh';

describe('useI18n', () => {
  it('falls back to Chinese for an invalid persisted language', () => {
    const { result } = renderHook(() => useI18n());

    expect(result.current.language).toBe('zh');
    expect(result.current.t('settings_language')).toBe('语言');
  });

  it.each([
    ['zh', zh, ['无法恢复', '云端', '备份']],
    ['en', en, ['irreversible', 'cloud', 'back up']],
  ] as const)('explains recovery, cloud sync and backup in both %s deletion warnings', (_language, messages, terms) => {
    for (const key of ['photos_review_warning', 'media_delete_warning'] as const) {
      for (const term of terms) expect(messages[key].toLowerCase()).toContain(term);
    }
  });
});
