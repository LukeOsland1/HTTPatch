# HTTPatch feature comparison

This compares HTTPatch with the core workflow described on [ModHeader's site](https://app.modheader.com/).
It is a guide for future development, not a claim of complete compatibility.

| Capability                                          | HTTPatch status                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Set, append, or remove request and response headers | Supported, subject to browser DNR limits                                                     |
| Pause all changes or toggle a profile or rule       | Supported                                                                                    |
| Multiple profiles and JSON import/export            | Supported; all enabled profiles can apply                                                    |
| Scope by request URL and resource type              | Supported, including a one-click current-site shortcut                                       |
| Scope to a browser tab                              | Supported with session rules; window scope is not yet supported                              |
| Add request Cookie and response Set-Cookie values   | Supported with structured fields; existing same-name cookies cannot be replaced individually |
| Build a Content-Security-Policy header              | Supported with editable policy and directive shortcuts                                       |
| Duplicate a header rule                             | Supported                                                                                    |
| Search common header names while typing             | Supported; custom names remain editable                                                      |
| Dynamic header values                               | Not yet supported                                                                            |
| Undo a rule edit                                    | Not yet supported beyond failed-save rollback                                                |

Remaining advanced features include dynamic values, undo, window-wide scope,
and replacement or removal of individual existing cookies. The browser's DNR
API can append Cookie and Set-Cookie headers but cannot reliably rewrite just
one existing cookie by name. URL filters match the **request URL**, so a profile
scoped to a site does not automatically match that page's requests to third-party
domains.
