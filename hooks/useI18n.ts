import en from '../i18n/en';
import zh from '../i18n/zh';
import { useSettingsStore } from '../stores/useSettingsStore';

const translations = {
    en,
    zh,
};

export function useI18n() {
    const language = useSettingsStore((state) => state.language);
    // Persisted settings can outlive an older build or be malformed. Keep a
    // bad value from turning the translation lookup into an undefined access.
    const safeLanguage = language === 'en' || language === 'zh' ? language : 'zh';

    const t = (key: keyof typeof en, params?: Record<string, string | number>) => {
        let text = translations[safeLanguage][key] || translations['en'][key] || key;

        if (params) {
            Object.entries(params).forEach(([k, v]) => {
                text = text.replace(`{${k}}`, String(v));
            });
        }

        return text;
    };

    return { t, language: safeLanguage };
}
