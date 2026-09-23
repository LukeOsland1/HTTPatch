# HTTPatch user guide

## Profiles and headers

Open the toolbar popup to create or select a profile. Each header row has an enable
switch, request/response target, operation, name and optional value. **Set** replaces
the header, **Remove** deletes it, and **Append** adds a value where supported.
Request append is limited to the browser's allowlist; response append is unrestricted.
Use the copy button beside a row to duplicate a rule for quick edits.
The header name field suggests popular names for the selected request or response
target. Type to filter, use the arrow keys and Enter to select, or enter any custom name.

Choose **Manage profiles & filters** to name, clone or delete profiles, add notes,
set badge text and colours, and edit filters. Selecting a profile chooses which one
you are editing; **all enabled profiles apply**, and later profiles win conflicts.
The global **Active / Paused** switch controls all modifications.
Use **This tab only** in the popup to bind the selected profile to the current
tab. Its rule is then kept in the browser's session rules instead of applying
in other tabs. If that tab closes, the profile stays tab-only but inactive;
open the popup on another page and choose **Use this tab**. Tab assignments do
not sync, so a synced tab-only profile is inactive on other devices until assigned.

Use **+ Request cookie** to append a named Cookie value to outgoing requests,
or **+ Set-Cookie** to add a named response cookie with attributes such as Path
and SameSite. These controls do not replace an existing cookie with the same
name. Use **+ CSP** for an editable Content-Security-Policy response header;
directive shortcuts add or replace common clauses. CSP rules start disabled so
you can review and scope the policy before enabling it.

## Scope rules to a site

Without include filters, a profile applies to all sites. Add a wildcard include such
as `||example.com^` to target that domain and its subdomains. A bare substring such as
`example.com` can match elsewhere in a URL; the anchored form gives a clearer boundary.
Multiple includes are alternatives. Empty includes do not create a match-all rule.
In the popup, **Scope to this site** replaces the selected profile's include filters
with the current web page's domain. It matches requests to that domain across tabs;
it does not restrict a rule to one browser tab. Exclude and resource-type filters stay.

Regex includes are supported by the browser's rule engine. Exclude filters must be
bare domains, such as `ads.example.com`; unsupported excludes produce a warning.
Resource-type filters narrow rules to requests such as images or fetch/XHR.

## Backup and import

Use **Export** to save your profiles as JSON, including header values. Store the file
carefully if it contains secrets. **Import** previews profiles and highlights changes
to security-related response headers before confirmation. Imported headers work
as ordinary rules.

## Sync, appearance and support

Sync is on by default and includes header values. Turn it off before adding secrets
if you do not want them in your browser account. **Remove synced copy** becomes available
after disabling sync. First-sync merge controls let you combine profiles or keep one side.

Light is the default appearance. Choose Dark or System in Settings if you prefer;
System follows your device's colour scheme. The footer offers an optional Ko-fi link.
**Privacy & credits** opens an offline page with the policy
and MIT licence. Donations never unlock or restrict features.

## Troubleshooting

If rules fail to apply, check the status bar for invalid values, unsupported append
operations, regex errors or the 5,000-rule limit. Browser-internal pages are not ordinary
websites and cannot be modified. Reload the target page or repeat the request after
changing a rule; changes do not alter responses that have already completed.
