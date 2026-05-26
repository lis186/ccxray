## 1. Cleanup deprecation paths (commit 3.1)

- [ ] 1.1 Remove `whichLegacyMechanism(req)` from auth.js
- [ ] 1.2 Remove `setDeprecation(res, value)` from auth.js
- [ ] 1.3 Remove `X-Ccxray-Deprecation` header logic from `verifyUpstream` and `verifyDashboard`
- [ ] 1.4 Remove `?token=` acceptance on any path (including `/` redirect)
- [ ] 1.5 Remove `url-sanitize.js` `stripAuthParams` for `token` (no longer needed — param rejected at gate)
- [ ] 1.6 Simplify `authMiddleware` → inline remaining logic into verifiers or delete entirely
- [ ] 1.7 Update tests: remove tests for legacy paths, verify 401 on `?token=`
- [ ] 1.8 CHANGELOG entry
- [ ] 1.9 Verify final LOC: auth.js ~180, dispatch in index.js ~25
