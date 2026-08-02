# Security

## Reporting

ccxray is a local-first developer tool maintained by one person. To report a
security issue, open a GitHub issue — or, for something sensitive, a private
advisory at <https://github.com/lis186/ccxray/security/advisories>.

## Trust model

ccxray runs on your own machine and binds the proxy + dashboard to a local port
(default 5577). By default it **trusts loopback**: any request whose TCP peer is
`127.0.0.1`/`::1` is authorized without a token or cookie, so `ccxray open` and
local scripts work with zero config. Set `CCXRAY_LOOPBACK_REQUIRE_AUTH=1` to
require the auth token on loopback too.

Binding to loopback stops *other machines* from connecting directly, but it is
**not an authentication boundary on its own**. A web page you visit in the same
browser can, in principle, send requests to the local port — the localhost-CSRF
/ DNS-rebinding class of bug, where the browser bridges a public origin to your
loopback service. For ccxray's posture this is a low, conditional risk rather
than a live hole: modern browsers gate public-site→loopback requests behind a
Local/Private Network Access permission; reads of recorded traffic are further
blocked by the same-origin policy; and the state-changing endpoints reachable
this way (intercept toggle / timeout / approve / reject) are low-impact. Even
so, the loopback IP proves only "same host," not "same trusted program" — so if
you run ccxray on a shared or higher-risk machine, set
`CCXRAY_LOOPBACK_REQUIRE_AUTH=1` and rely on the auth token.
