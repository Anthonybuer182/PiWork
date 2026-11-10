import { useCallback, useEffect } from 'react';
import { electronApi } from '../lib/electron-ipc';
import { useLanguageStore, type Language } from './language-store';
import { EN_MESSAGES, type MessageKey } from './messages.en';

export { useLanguageStore, LANGUAGE_OPTIONS, type Language } from './language-store';
export type { MessageKey } from './messages.en';

/** Fill `{name}` placeholders; unknown names are left untouched. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

export function translate(
  language: Language,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  return interpolate(language === 'en' ? EN_MESSAGES[key] : key, vars);
}

/**
 * Imperative translation for code that is not a React component (stores,
 * helpers). Components must use `useI18n()` instead: only the hook subscribes
 * to the store and re-renders when the language changes.
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(useLanguageStore.getState().language, key, vars);
}

export function useI18n() {
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);
  /**
   * Stable identity on purpose: it reads the store at call time instead of
   * closing over `language`. Memoized event handlers (`useCallback`) that
   * captured it on an earlier render would otherwise keep translating with
   * the language that was current when they were created.
   */
  const tr = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) =>
      translate(useLanguageStore.getState().language, key, vars),
    [],
  );
  return { language, setLanguage, t: tr };
}

/**
 * Keep `<html lang>` in step — assistive tech and spellcheck read it — and
 * tell the desktop shell about the change so its native menu bar can relabel
 * itself. The menu is app-global and lives in main, which cannot read our
 * localStorage; on mount this also corrects a menu built with the default
 * language before the renderer loaded. No-op in the web build.
 */
export function useLanguageSync(): void {
  const language = useLanguageStore((s) => s.language);
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    electronApi()
      ?.invoke('pi:app:setLanguage', language)
      .catch(() => {});
  }, [language]);
}
