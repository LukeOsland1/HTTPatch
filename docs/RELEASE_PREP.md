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

## Chrome Web Store privacy fields

**Single purpose:** Let users create browser profiles that set, append or remove
HTTP request and response headers for websites they choose.

**Data handling:** Profiles can contain header values such as authentication tokens
or cookies, notes, and URL/site filters. HTTPatch stores these locally and syncs
profiles through the browser account by default. It does not send them to the
developer or an analytics service. Opening the popup reads the current tab URL
for the site shortcut; choosing that shortcut saves the domain as a filter.
Describe these behaviours in the Privacy practices tab, including any applicable
authentication, website and user-provided data categories. Do not claim that the
extension handles no user data merely because it has no developer server.

Use the published HTTPS privacy-page URL in the dashboard's privacy-policy field.
The [Chrome Web Store privacy guidance](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
explains the single-purpose, permission and data-use fields.

## Steps before the first release

1. Use the prepared `1.0.0` version and notes in `CHANGELOG.md`. Check
   [GitHub CI](https://github.com/LukeOsland1/HTTPatch/actions) and run the
   packaged browser test locally. Review the screenshots and listing copy.
2. Publish the public HTTPS privacy page and run `npm run check:privacy` with
   `PRIVACY_POLICY_URL` set to its address.
3. Push `v1.0.0` intentionally. The release workflow rejects a tag that
   differs from `package.json` or has no changelog section, and creates a draft.
4. Review the draft Chromium ZIP and notes, then publish the GitHub release when
   the repository is ready to be public. A Firefox XPI is attached only when
   Mozilla signing credentials are configured.
5. Create the Chrome Web Store listing manually. Upload the Chromium ZIP, add the
   prepared images and descriptions, complete the Privacy practices tab and
   submit it for review. Keep the listing ID and credentials private.
6. After the initial listing exists, configure and test the manual Chrome Web
   Store workflow for updates. Automated deployment can be enabled after its
   publisher and extension IDs have been verified.

Do not add publisher tokens or signing keys to the repository. A signed Firefox
XPI and authenticated Chrome Web Store upload require personal credentials; an
unsigned Firefox XPI is suitable only for temporary development loading.
