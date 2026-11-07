import { BUILTIN_PALETTES } from './vendor/theme.ts';
import { t, languages, LANGUAGE } from './i18n.ts';
type Theme = {
    scheme: string;
    mode: 'light' | 'dark' | 'system';
};
let theme: Theme = { scheme: 'crab-daisy', mode: 'system' };
const media = matchMedia('(prefers-color-scheme: dark)');
function apply() {
    const mode = theme.mode === 'system' ? (media.matches ? 'dark' : 'light') : theme.mode;
    const palette = (BUILTIN_PALETTES[theme.scheme] || BUILTIN_PALETTES['crab-daisy'])[mode];
    for (const [key, value] of Object.entries(palette))
        document.documentElement.style.setProperty(`--${key}`, value);
    document.documentElement.style.colorScheme = mode;
}
media.addEventListener('change', apply);
export function initTheme(value: Theme) { theme = value; apply(); }
export function languageSettings(root: HTMLElement) {
    root.className = 'language-options';
    for (const [key, label] of Object.entries(languages)) {
        const b = document.createElement('button');
        b.className = 'btn';
        b.textContent = label;
        b.disabled = key === LANGUAGE;
        b.onclick = () => { localStorage.setItem('manager.language', key); location.reload(); };
        root.append(b);
    }
}
export function appearanceSettings(root: HTMLElement, api: (path: string, body?: unknown) => Promise<any>, toast: (text: string) => void) {
    root.innerHTML = `<form class="appearance-form"><select class="field" name="mode" aria-label="${t('外观')}">${(['system', 'light', 'dark'] as const).map((v, i) => `<option value="${v}" ${v === theme.mode ? 'selected' : ''}>${t(['跟随系统', '浅色', '深色'][i])}</option>`).join('')}</select><select class="field" name="scheme" aria-label="${t('配色')}">${Object.keys(BUILTIN_PALETTES).map(v => `<option value="${v}" ${v === theme.scheme ? 'selected' : ''}>${v}</option>`).join('')}</select><button class="btn">${t('保存')}</button></form>`;
    root.querySelector('form')!.onsubmit = async (e) => {
        e.preventDefault();
        const value = Object.fromEntries(new FormData(e.currentTarget as HTMLFormElement)) as Theme;
        try {
            await api('/api/theme', value);
            initTheme(value);
            toast(t('已保存'));
        }
        catch (error) {
            toast((error as Error).message);
        }
    };
}
