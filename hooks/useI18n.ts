import en from '../i18n/en';
import zh from '../i18n/zh';
import { useSettingsStore } from '../stores/useSettingsStore';

const translations = {
    en,
    zh,
};

export function useI18n() {
    const language = useSettingsStore((state) => state.language);

    const t = (key: keyof typeof en, params?: Record<string, string | number>) => {
        let text = translations[language][key] || translations['en'][key] || key;

        if (params) {
            Object.entries(params).forEach(([k, v]) => {
                text = text.replace(`{${k}}`, String(v));
            });
        }

        return text;
    };

    return { t, language };
}
