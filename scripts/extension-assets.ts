import { readFileSync } from 'node:fs';
import { marked } from 'marked';
import type { Plugin } from 'vite';

/** Include the privacy policy and MIT licence in every package. */
export function extensionAssets(): Plugin {
  return {
    name: 'httpatch-extension-assets',
    generateBundle() {
      const policy = readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8');
      const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
      this.emitFile({ type: 'asset', fileName: 'LICENSE.txt', source: license });
      this.emitFile({
        type: 'asset',
        fileName: 'privacy.html',
        source: `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HTTPatch — Privacy & credits</title>
<style>:root{color-scheme:light dark}body{font:16px/1.7 system-ui,sans-serif;max-width:780px;margin:48px auto;padding:0 24px}a{color:light-dark(#4338ca,#a5b4fc)}pre{white-space:pre-wrap}</style>
</head><body>${marked.parse(policy, { async: false })}
<h2>Credits & licence</h2><p>HTTPatch is created and maintained by Luke Osland.</p>
<pre>${license.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>
</body></html>`,
      });
    },
  };
}
