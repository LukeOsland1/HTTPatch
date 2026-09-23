# Contributing to HTTPatch

Use Node.js 22.13+ and install dependencies with `npm ci`. CI uses Node 24.

## Validation

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run check:manifest
npm run build:firefox
npm run lint:firefox
npm run test:browser
npm run build:privacy
npm audit
```

`npm run format` formats source files. Generated outputs and local backups are ignored.
`npm run gen:icons` regenerates the four icons from the code-based H glyph.

`npm run test:browser` runs the built extension in Playwright Chromium. Install the
browser once with `npx playwright install chromium`; CI installs it automatically.
On Windows it uses installed Chrome by default. Run
`node test/e2e/browser.e2e.mjs dist --screenshots` to refresh the release images
in `docs/screenshots/`; the test uses a disposable browser profile and example data.
It covers header application, popup editing, browser sync and storage recovery.

Load `dist/` unpacked in Chromium for manual checks. Create a request rule scoped
to `||httpbin.org^`, set `X-Test-Header: hello`, and visit `https://httpbin.org/headers`.
Check editing, pause, import/export, profile switching and light/dark themes.

## Conventions

- Keep rule compilation pure and browser APIs at storage/apply/background boundaries.
- Chromium and Firefox share core logic and UI; Firefox adapters live in `firefox/`.
- Preserve the MIT licence and Luke Osland attribution. Update `PRIVACY.md` when data handling changes.
- Personal links live in `src/brand.json`; mirror changes in `package.json`,
  `.github/FUNDING.yml` and public documentation where applicable.
- Keep active storage keys under the HTTPatch namespace. The one-time transfer
  of previous keys belongs in `src/core/storage-compat.ts`.

## Packaging and releases

`npm run zip` creates one Chromium ZIP in `release/` for Chrome, Edge, Brave and Arc
on Windows, macOS or Linux.
`npm run pack:firefox` creates a Firefox XPI. Without `AMO_JWT_ISSUER` and
`AMO_JWT_SECRET`, it is unsigned and suitable for temporary development loading.
With those credentials it requests an unlisted Mozilla signature.

The Firefox identity is `httpatch@lukeosland1`. Keep it stable after first publication.
Chrome assigns a new identity when a new store listing is created. Configure new
personal store IDs, signing keys and credentials for this project.

For a release, choose a version, update `package.json` and the lockfile, write the
matching changelog section, and push a matching `v<version>` tag. The release workflow
checks that the tag and changelog match, validates both builds, and creates a **draft** GitHub Release. There is no automatic
version tagging on merges. Review the draft before publishing it.

Chrome Web Store publishing is a separate **manual** workflow. Configure the personal
`release` environment with `CRX_PRIVATE_KEY`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`,
`CWS_REFRESH_TOKEN`, and variables `CWS_PUBLISHER_ID`, `CWS_ITEM_ID` and
`CWS_VERIFIED_UPLOAD_KEY_ID`. Its publisher
script is for listings configured for verified CRX uploads. For a first manual listing,
use the Chromium ZIP. No personal listing has been configured here.

The public privacy page is built from `PRIVACY.md` and deployed to GitHub Pages by
the privacy-page workflow on `main`. After changing the policy, wait for deployment
and run `npm run check:privacy` to compare the live page with the source. The
extension also includes an offline privacy page.
