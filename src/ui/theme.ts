import { useEffect } from 'preact/hooks';
import type { Settings } from '@/core/types';

/** Apply the chosen theme by setting data-theme on <html>. CSS does the rest. */
export function useTheme(theme: Settings['theme'] | undefined): void {
  useEffect(() => {
    const el = document.documentElement;
    if (theme) el.dataset.theme = theme;
    else delete el.dataset.theme; // No saved setting yet: render the light default.
  }, [theme]);
}
