# HTTPatch release preparation

This is a draft for the first release. The repository and extension remain
private and unpublished until the release and store listings are deliberately set up.

## Browser store listing copy

**Name:** HTTPatch

**Short description:** Create and switch profiles that modify HTTP request and response headers.

**Full description:** HTTPatch helps you test and customise HTTP headers in your browser.
Set, append or remove request and response headers; group rules into named profiles;
scope them by URL, resource type or browser tab; add Cookie, Set-Cookie and CSP
rules with focused editors; pick popular header names from a searchable list or type
your own; duplicate a rule; and pause all changes with one switch.
Import or export profiles as JSON. Optional browser-account sync follows your profiles
between devices and is on by default, including header values. No ads, analytics,
account requirement or paid features. Created and maintained by Luke Osland.

**Category:** Developer Tools

**Store graphics:**

These images follow the [Chrome Web Store image guidance](https://developer.chrome.com/docs/webstore/best-listing#images).
The three listing screenshots are 1280×800 and show the current UI with example data.
The small promotional tile is 440×280; the optional marquee is 1400×560.

- [Options, light](screenshots/options-light.png)
- [Options, dark](screenshots/options-dark.png)
- [Popup listing screenshot](screenshots/popup-store.png)
- [Small promotional tile](store-assets/promo-small.png)
- [Optional marquee](store-assets/promo-marquee.png)
- [128×128 store icon](../icons/icon-128.png)

The [site-scoped popup capture](screenshots/popup-site.png),
[header picker capture](screenshots/popup-header-picker.png),
[editable promo SVGs](store-assets/) are retained as sources. After a UI change, run
`npm run build`, `npm run test:browser -- --screenshots`, and
`node scripts/render-store-assets.mjs` to refresh the listing graphics.

**Support:** [GitHub issues](https://github.com/LukeOsland1/HTTPatch/issues)

**Optional donations:** [Ko-fi](https://ko-fi.com/lukeosland)

**Privacy policy:** [PRIVACY.md](../PRIVACY.md) is the source. Publish the privacy
page before submitting a public store listing, then use that public HTTPS URL.
The extension package also contains an offline `privacy.html` page.

## Permission explanations

- `declarativeNetRequestWithHostAccess`: apply user-defined header rules through
  the browser's declarative network API.
- `<all_urls>` host access: rules may target any site the user chooses.
- `storage`: keep local profiles and replicate them through browser-account sync.
- `tabs` is not requested; existing host access lets the popup read the current
  tab's URL for site and tab shortcuts. Tab IDs stay in session storage only.
- `alarms`: batch sync writes and check for changes from other devices.

## Steps before the first release

1. Choose the HTTPatch release version. Update `package.json` and `package-lock.json`,
   and add a matching dated section to `CHANGELOG.md`.
2. Check [GitHub CI](https://github.com/LukeOsland1/HTTPatch/actions) and run the
   packaged browser test locally. Review the screenshots and listing copy.
3. Create Chrome Web Store and, if wanted, Mozilla add-on listings. Keep their
   IDs and signing credentials private.
4. Publish a public HTTPS privacy-policy URL. The manual Pages workflow publishes
   only `PRIVACY.md`; GitHub Pages must first be enabled for this repository.
5. Push `v<version>` intentionally. The release workflow now rejects a tag that
   differs from `package.json` or has no changelog section, and creates a draft.
6. Review the draft packages and notes. Publish the GitHub release and submit store
   listings separately when ready. The Chrome Web Store workflow is manual and
   assumes a personal listing configured for verified CRX uploads.

Do not add publisher tokens or signing keys to the repository. A signed Firefox
XPI and authenticated Chrome Web Store upload require personal credentials; an
unsigned Firefox XPI is suitable only for temporary development loading.
