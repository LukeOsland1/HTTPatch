# HTTPatch Privacy Policy

_Last updated: 23 September 2026_

HTTPatch is maintained by [Luke Osland](https://github.com/LukeOsland1). It modifies
HTTP headers using rules you configure. It has no developer-operated server,
analytics, advertising or tracking.

## Local storage and exports

Profiles, header names and values, filters, colours and settings are stored on your
device using the browser's `storage.local` API. These values are not encrypted by
HTTPatch and may include credentials such as tokens or cookies.

Import and export read and write JSON files locally at your request. Exported files
include header values in plaintext. The extension warns before exporting recognised
credential headers and previews imported rules before you confirm them.

## Browser sync

**Profile sync is on by default.** Profiles, including their header values, and your
theme preference are copied into your browser account's `storage.sync` area. Your
browser provider handles replication and its account protections apply. HTTPatch does
not add its own encryption and the developer does not receive the synced data.
Pause state and the selected profile stay local to each device.
The tab-only setting travels with a profile; its assigned tab ID is stored only
for the current browser session on this device. A tab-only profile without an
assignment stays inactive, including after a restart or on another device.

You can turn **Sync** off in the options page. Use **Remove synced copy** afterwards
to delete previously uploaded data. Your local profiles remain. To ensure the
synced copy is removed, do this before uninstalling the extension.

## Websites and permissions

HTTPatch uses `declarativeNetRequestWithHostAccess` to apply your header rules.
Broad host access is requested because rules can target any website. Header changes
are applied by the browser: HTTPatch does not read request or response bodies.
When you open the popup, HTTPatch reads the current tab's URL to offer a site
shortcut. Opening the popup alone does not save that URL. If you choose
**Scope to this site**, the site's domain is saved as a profile filter and may
be included in browser sync. HTTPatch does not send the URL to the developer.

HTTPatch includes **no content scripts** and does not read page content, forms,
browsing history or user activity.

The `storage` permission saves settings and supports browser sync. The `alarms`
permission schedules sync batches and periodic checks for profile changes.

HTTPatch uses this data only to apply the rules you configure and to sync your
profiles if enabled. The developer cannot read your profiles, header values or
site filters, and does not use them for advertising.

## External links and donations

Author and optional donation links open only when clicked. They do not include your
profiles or header values. Destination sites have their own privacy policies.
Donations are handled by [Ko-fi](https://ko-fi.com/lukeosland); HTTPatch does not
collect payment details. All features remain free regardless of donations.

## Retention and contact

Delete profiles or uninstall the extension to remove locally stored configuration.
To remove synced data, turn sync off and choose **Remove synced copy** first.

Maintainer contact details are available on
[Luke Osland's GitHub profile](https://github.com/LukeOsland1).
Updates to this policy are included with the extension and in the project documentation.
