<!--
Checked-in copy of the "## Mutation inventory" table from implementation-contract.md.

Source of truth (istra tracker, NOT part of this repo, not available in CI):
~/repos/istra/2-InProgress/KRKG-0050 - Centralny, czytelny audyt operacji zapisu/implementation-contract.md

mutation-inventory.test.ts parses THIS file (not the istra path, which CI and other developers'
checkouts do not have) and compares it against server.ts's live dispatch chain. That comparison is
only a real gate against contract/code drift if this copy is kept byte-for-byte in sync with the
istra document's table.

Whoever edits the "## Mutation inventory" table in implementation-contract.md MUST copy the same
table into this file in the same change. If you forget, this test will keep passing against a
stale copy while the real contract document silently diverges - exactly the failure mode this
fixture exists to prevent.

Last synced with implementation-contract.md: 2026-09-11 (KRKG-0070 batch 4/7).
-->

| Method and route | Classification and action | Resource and side effect | Execution |
| --- | --- | --- | --- |
| POST `/session/login` | businessWrite — `session.login.succeeded` | session; Firestore login state | requestAwaited |
| POST `/session/logout` | transientNoBusinessWrite — clears only the session response/cookie | no business record | n/a |
| POST `/application/pwa-installation` | businessWrite — `application.pwa.installation_reported` | application; Firestore marker (`applicationInstallations`) plus one canonical event | requestAwaited |
| POST `/membership/apply` | businessWrite — `membership.application.submitted` | member; Firestore | requestAwaited |
| POST `/admin/social-media/refresh` | businessWrite — `site.social_cache.refreshed` | settings; cache mutation | requestAwaited |
| POST `/admin/members/transition` | businessWrite — data-resolved membership status action; correlated `membership.sheet_backup.synchronized` if mirror is requested | member; Firestore, optional Sheets | Firestore requestAwaited; Sheets auditedOperationEnvelope |
| PUT `/admin/members/drive-folder` | businessWrite — `profile.drive_folder.changed` | member; Firestore | requestAwaited |
| PUT `/admin/members/profile` | businessWrite — `profile.member.updated` | member; Firestore | requestAwaited |
| POST `/admin/members/synchronize` | businessWrite — `membership.sheet_backup.synchronized` | member set; Sheets | auditedOperationEnvelope |
| PUT `/admin/roles` | businessWrite — data-resolved role action | member; Firestore | requestAwaited |
| POST/DELETE `/admin/redirects` | businessWrite — `site.redirect.created` / `site.redirect.deleted` | redirect; GitHub | auditedOperationEnvelope |
| POST `/admin/people` | businessWrite — `profile.person.created` | person; Drive folder and optional description; provisional key then final person folder key | auditedOperationEnvelope |
| PUT `/admin/people/description` | businessWrite — `profile.person.description.updated` | person; Drive text file | auditedOperationEnvelope |
| PUT `/admin/people/order` | businessWrite — `profile.person.order.updated` | person; Drive folder rename | auditedOperationEnvelope |
| PUT `/admin/people/category` | businessWrite — `profile.person.category.changed` | person; Drive folder move/rename | auditedOperationEnvelope |
| DELETE `/admin/people` | businessWrite — `profile.person.deleted` | person; Drive folder deletion | auditedOperationEnvelope |
| POST/DELETE `/admin/people/photo` | businessWrite — `profile.person.photo.added` / `profile.person.photo.deleted` | person; Drive/Firestore | auditedOperationEnvelope |
| PUT `/admin/people/photo/main` | businessWrite — `profile.person.photo.main.changed` | person; Drive file rename | auditedOperationEnvelope |
| PUT `/admin/people/photo/transfer` | businessWrite — `profile.person.photo.transferred` | person; Drive file move | auditedOperationEnvelope |
| PUT `/admin/people/photo/approve` | businessWrite — `profile.person.created` / `profile.drive_folder.changed` / `profile.person.photo.transferred` / `profile.person.photo.main.changed` | person / member; Drive folder create + file move + optional rename, Firestore driveFolderId link | auditedOperationEnvelope |
| PUT `/admin/people/in-memoriam` | businessWrite — `profile.person.in_memoriam.changed` | person; Drive marker file | auditedOperationEnvelope |
| POST `/wojownicy-upload/submit` | businessWrite — `profile.photo_submission.created` | member submission; Drive folder; provisional key then final submission folder key | auditedOperationEnvelope |
| POST `/wojownicy-upload/photo` | businessWrite — `profile.photo_submission.photo_added` | member submission; Drive photo | auditedOperationEnvelope |
| DELETE `/lista-wyjazdowa/profile/photo` | businessWrite — `profile.photo_submission.photo_deleted` | member submission; Drive photo deletion, scoped to caller's own stagingFolderId | auditedOperationEnvelope |
| PUT `/lista-wyjazdowa/member` | businessWrite — `profile.member.updated` | member; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/profile` | businessWrite — `profile.member.updated` | member; Firestore | requestAwaited |
| POST `/lista-wyjazdowa/events` | businessWrite — `event.created` | event; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/events` | businessWrite — `event.updated` / `event.cancelled`, plus `dues.event_fee.changed` only when its fee changes | event and optional eventFee; Firestore; two independent effects emit two events in one transaction | requestAwaited |
| PUT `/lista-wyjazdowa/signups` | businessWrite — data-resolved `signup.created` / `signup.updated` | signup; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/signups/skladka` | businessWrite — `dues.event_fee.changed` | eventFee; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/wpisowe` | businessWrite — `dues.entry_fee.changed` | due; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/dues` | businessWrite — `dues.annual.changed` | due; Firestore | requestAwaited |
| POST `/admin/settings` | businessWrite — `site.settings.updated` | settings; Drive text/config file | auditedOperationEnvelope |
| POST `/delete-drive-gallery` | businessWrite — `gallery.deleted` | gallery; Drive | auditedOperationEnvelope |
| POST `/start` | businessWrite — `gallery.created` | gallery; Drive folder/public share; provisional key then final gallery folder key | auditedOperationEnvelope |
| POST `/register` | businessWrite — `gallery.registered` | gallery; GitHub | auditedOperationEnvelope |
| POST `/unregister` | businessWrite — `gallery.unregistered` | gallery; GitHub | auditedOperationEnvelope |
| POST `/upload` | businessWrite — `gallery.photo.added` | gallery; Drive file and allowed attribution metadata | auditedOperationEnvelope |
| POST `/finalize` | businessWrite — `gallery.finalized` | gallery; Drive manifest | auditedOperationEnvelope |
| POST `/gallery-photos/start` | transientNoBusinessWrite — verifies an existing gallery and issues only an expiring submission token | no business record | n/a |
| POST `/gallery-photos/finalize` | businessWrite — `gallery.photo.contribution.finalized` | gallery; Drive manifest/public share | auditedOperationEnvelope |
