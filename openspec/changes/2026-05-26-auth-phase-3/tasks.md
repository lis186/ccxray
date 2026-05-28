## 1. Cleanup deprecation paths (commit `23e787d`)

- [x] 1.1 Remove `whichLegacyMechanism(req)` from auth.js
- [x] 1.2 Remove `setDeprecation(res, value)` from auth.js
- [x] 1.3 Remove `X-Ccxray-Deprecation` header logic from `verifyDashboard` (upstream never set it post-2.2b)
- [x] 1.4 Remove `?token=` acceptance on any path (dashboard was the last; no `/` redirect existed)
- [ ] ~~1.5 Remove `url-sanitize.js` `stripAuthParams` for `token`~~ — **deviation**: kept as defense-in-depth. The rationale "rejected at gate" doesn't cover a request that carries a valid `X-Ccxray-Auth` header AND a stray `?token=foo` in the URL — gate passes, URL would be forwarded/logged with `foo`. Strip is cheap (~30 LOC), 8 callers in forward.js/ws-proxy.js retained.
- [x] 1.6 Delete `authMiddleware` entirely (no remaining callers; `AUTH_TOKEN` const stays internal, no longer exported)
- [x] 1.7 Tests: deleted `test/auth.test.js` (5 authMiddleware tests); inverted dashboard `?token=` test to assert 401; renamed two `auth-bootstrap.test.js` labels that said "falls through to authMiddleware"
- [x] 1.8 CHANGELOG entry folded into the 1.10.0 release (`0361cdd`)
- [x] 1.9 ~~Verify final LOC: auth.js ~180, dispatch in index.js ~25~~ — **target was unrealistic**: 2.x accumulated HKDF + cookie + dispatch + two gates + autoopen, so auth.js is 486 LOC (down 54 from pre-Phase-3); dispatch site in index.js is ~3 lines (line 224) as planned.
