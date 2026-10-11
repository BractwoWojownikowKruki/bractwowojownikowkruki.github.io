<!--
Current mutation inventory for this repository.

mutation-inventory.test.ts compares this table with server.ts dispatch in every
checkout, including CI. Update this table in the same change when adding,
removing, or reclassifying a route. Completed Istra story documents describe
historical work and do not need to stay synchronized with this contract.
-->

| Method and route | Classification and action | Resource and side effect | Execution |
| --- | --- | --- | --- |
| POST `/session/login` | businessWrite — `session.login.succeeded` | session; Firestore login state | requestAwaited |
| POST `/session/logout` | transientNoBusinessWrite — clears only the session response/cookie | no business record | n/a |
| POST `/application/pwa-installation` | businessWrite — `application.pwa.installation_reported` | application; Firestore marker (`applicationInstallations`) plus one canonical event | requestAwaited |
| POST `/membership/apply` | businessWrite — `membership.application.submitted` | member; Firestore; best-effort e-mail to the configured recipient roles on a new application | requestAwaited |
| POST `/membership/photos/start` | businessWrite — `profile.photo_submission.created` | member submission; Drive folder (pending applicant); provisional key then final submission folder key | auditedOperationEnvelope |
| POST `/membership/photo` | businessWrite — `profile.photo_submission.photo_added` | member submission; Drive photo (pending applicant, max 3 photos of 10 MB) | auditedOperationEnvelope |
| POST `/admin/social-media/refresh` | businessWrite — `site.social_cache.refreshed` | settings; cache mutation | requestAwaited |
| POST `/admin/members/transition` | businessWrite — data-resolved membership status action; correlated `membership.sheet_backup.synchronized` if mirror is requested | member; Firestore, optional Sheets; best-effort e-mail to the member on approve/reject | Firestore requestAwaited; Sheets auditedOperationEnvelope |
| PUT `/admin/members/drive-folder` | businessWrite — `profile.drive_folder.changed` | member; Firestore | requestAwaited |
| PUT `/admin/members/profile` | businessWrite — `profile.member.updated` | member; Firestore | requestAwaited |
| PUT `/admin/members/weapons` | businessWrite — `profile.member.updated` | member; Firestore | requestAwaited |
| POST `/admin/members/synchronize` | businessWrite — `membership.sheet_backup.synchronized` | member set; Sheets | auditedOperationEnvelope |
| PUT `/admin/roles` | businessWrite — data-resolved role action | member; Firestore | requestAwaited |
| POST/DELETE `/admin/redirects` | businessWrite — `site.redirect.created` / `site.redirect.deleted` | redirect; GitHub | auditedOperationEnvelope |
| PUT `/admin/people/description` | businessWrite — `profile.person.description.updated` | person; Drive text file | auditedOperationEnvelope |
| PUT `/admin/people/order` | businessWrite — `profile.person.order.updated` | person; Drive folder rename | auditedOperationEnvelope |
| PUT `/admin/people/category` | businessWrite — `profile.person.category.changed` | person; Drive folder move/rename | auditedOperationEnvelope |
| DELETE `/admin/people` | businessWrite — `profile.person.deleted` | person; Drive folder deletion | auditedOperationEnvelope |
| POST/DELETE `/admin/people/photo` | businessWrite — `profile.person.photo.added` / `profile.person.photo.deleted` | person; Drive/Firestore | auditedOperationEnvelope |
| PUT `/admin/people/photo/main` | businessWrite — `profile.person.photo.main.changed` | person; Drive file rename | auditedOperationEnvelope |
| PUT `/admin/people/photo/transfer` | businessWrite — `profile.person.photo.transferred` | person; Drive file move | auditedOperationEnvelope |
| PUT `/admin/people/photo/approve` | businessWrite — `profile.person.created` / `profile.drive_folder.changed` / `profile.person.photo.transferred` / `profile.person.photo.main.changed` | person / member; Drive folder create + file move + optional rename, Firestore driveFolderId link; best-effort e-mail to the member | auditedOperationEnvelope |
| PUT `/admin/people/photo/reject` | businessWrite — `profile.photo_submission.photo_rejected` | member submission; Drive file move into the staging folder's Odrzucone subfolder plus comment sidecar; best-effort e-mail to the member | auditedOperationEnvelope |
| PUT `/admin/people/in-memoriam` | businessWrite — `profile.person.in_memoriam.changed` | person; Drive marker file | auditedOperationEnvelope |
| POST `/wojownicy-upload/submit` | businessWrite — `profile.photo_submission.created` | member submission; Drive folder; provisional key then final submission folder key | auditedOperationEnvelope |
| POST `/wojownicy-upload/photo` | businessWrite — `profile.photo_submission.photo_added` | member submission; Drive photo | auditedOperationEnvelope |
| POST `/wojownicy-upload/finish` | transientNoBusinessWrite — verifies the caller's submission token and only sends the one "new photos waiting" e-mail per upload session | no business record | n/a |
| DELETE `/lista-wyjazdowa/profile/photo` | businessWrite — `profile.photo_submission.photo_deleted` (default/`source=staging`, or `source=rejected`) or `profile.person.photo.deleted` (`source=public`) | member submission or person; Drive photo deletion, scoped to caller's own stagingFolderId, its Odrzucone subfolder, or driveFolderId | auditedOperationEnvelope |
| POST `/lista-wyjazdowa/profile/photo/main` | businessWrite — `profile.person.photo.main.changed` | person; Drive file rename, scoped to caller's own driveFolderId | auditedOperationEnvelope |
| PUT `/lista-wyjazdowa/member` | businessWrite — `profile.member.updated` | member; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/profile` | businessWrite — `profile.member.updated` | member; Firestore | requestAwaited |
| POST `/lista-wyjazdowa/events` | businessWrite — `event.created` | event; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/events` | businessWrite — `event.updated` / `event.cancelled`, plus `dues.event_fee.changed` only when its fee changes | event and optional eventFee; Firestore; two independent effects emit two events in one transaction | requestAwaited |
| PUT `/lista-wyjazdowa/signups` | businessWrite — data-resolved `signup.created` / `signup.updated` | signup; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/event-equipment` | businessWrite — `equipment.event_going.changed` | eventEquipment; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/signups/skladka` | businessWrite — `dues.event_fee.changed` | eventFee; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/wpisowe` | businessWrite — `dues.entry_fee.changed` | due; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/dues` | businessWrite — `dues.annual.changed` | due; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/dues/year-fee` | businessWrite — `dues.year_fee.changed` | due; Firestore | requestAwaited |
| POST `/lista-wyjazdowa/persons` | businessWrite — `person.created` | person; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/persons` | businessWrite — `person.updated` | person; Firestore | requestAwaited |
| DELETE `/lista-wyjazdowa/persons` | businessWrite — `person.deleted` | person; Firestore | requestAwaited |
| DELETE `/lista-wyjazdowa/persons/permanent` | businessWrite — `person.purged` | person, profile, signup and dues; Firestore; one transaction | requestAwaited |
| PUT `/lista-wyjazdowa/persons/owner` | businessWrite — `person.detached` | person; Firestore | requestAwaited |
| PUT `/lista-wyjazdowa/persons/account` | businessWrite — `person.merged` | person and member; Firestore | requestAwaited |
| POST `/lista-wyjazdowa/signups/quick-add` | businessWrite — `person.created` + `signup.created` for `mode=new`; `signup.created` / `signup.updated` for `mode=existing` | person and signup; Firestore; one transaction | requestAwaited |
| POST `/admin/settings` | businessWrite — `site.settings.updated` | settings; Drive text/config file | auditedOperationEnvelope |
| PUT `/admin/settings/notifications` | businessWrite — `site.settings.updated` | settings; Firestore (`notificationSettings`: e-mail and push recipient roles) | requestAwaited |
| PUT `/profile/notifications` | businessWrite — `profile.notifications.updated` | member; Firestore (`notificationPreferences`: e-mail opt-out) | requestAwaited |
| POST `/profile/notifications/push` | businessWrite — `profile.notifications.updated` | member; Firestore (`notificationPreferences`: push device added) | requestAwaited |
| DELETE `/profile/notifications/push` | businessWrite — `profile.notifications.updated` | member; Firestore (`notificationPreferences`: push device removed) | requestAwaited |
| POST `/delete-drive-gallery` | businessWrite — `gallery.deleted` | gallery; Drive | auditedOperationEnvelope |
| POST `/start` | businessWrite — `gallery.created` | gallery; Drive folder/public share; provisional key then final gallery folder key | auditedOperationEnvelope |
| POST `/register` | businessWrite — `gallery.registered` | gallery; GitHub | auditedOperationEnvelope |
| POST `/unregister` | businessWrite — `gallery.unregistered` | gallery; GitHub | auditedOperationEnvelope |
| POST `/upload` | businessWrite — `gallery.photo.added` | gallery; Drive file and allowed attribution metadata | auditedOperationEnvelope |
| POST `/finalize` | businessWrite — `gallery.finalized` | gallery; Drive manifest | auditedOperationEnvelope |
| POST `/gallery-photos/start` | transientNoBusinessWrite — verifies an existing gallery and issues only an expiring submission token | no business record | n/a |
| POST `/gallery-photos/finalize` | businessWrite — `gallery.photo.contribution.finalized` | gallery; Drive manifest/public share | auditedOperationEnvelope |
| POST/DELETE `/files` | businessWrite — `file.added` / `file.deleted` | file; Firestore | requestAwaited |
| POST/PUT/DELETE `/equipment` | businessWrite — `equipment.added` / `equipment.updated` / `equipment.deleted` | equipment; Firestore | requestAwaited |
