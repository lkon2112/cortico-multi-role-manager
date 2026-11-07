import { translationLanguages, translations } from './locales.ts';
export const languages: Record<string, string> = { zh: '简体中文', 'zh-Hant': '繁體中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', 'es-419': 'Español (Latinoamérica)', 'pt-BR': 'Português (Brasil)', it: 'Italiano', ru: 'Русский' };
const saved = localStorage.getItem('manager.language');
export const LANGUAGE = saved && languages[saved] ? saved : navigator.language.startsWith('zh') ? 'zh' : 'en';
export const locale = LANGUAGE === 'zh' ? 'zh-CN' : LANGUAGE;
document.documentElement.lang = locale;
export function t(key: string, ...values: unknown[]): string {
    const i = translationLanguages.indexOf(LANGUAGE as typeof translationLanguages[number]);
    const text = i < 0 ? key : translations[key]?.[i] ?? key;
    return text.replace(/\{(\d+)\}/g, (match, i) => i < values.length ? String(values[i]) : match);
}
