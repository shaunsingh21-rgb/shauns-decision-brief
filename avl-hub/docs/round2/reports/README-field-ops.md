# r2-field-ops: field features prototype (SAMPLE data only, nothing approved)

Apply: `cd avl-hub && patch -p0 --dry-run < prototype.patch` (paths are relative; or copy the new files: server/routes/search.js, migrations/008_issue_photo.sql,
public/js/offline.js, public/js/views/{search,scan,labels,card}.js, public/js/lib/jsqr.js; edits in app.js, equipment.js, issues.js, app.css, server/index.js, server/routes/issues.js).
Run the prototype: see ../restart.sh (port 4208). Test scripts: t2 search, t3/t3b QR + printed decode, t4 offline, t6 quick actions/camera/red mode.

Production notes
* search: lazily-rebuilt FTS5 table (signature check). For production use triggers or rebuild on write. Weight open issues above resolved.
* QR URL uses PUBLIC_URL env if set, otherwise Host header: SET PUBLIC_URL in production.
* jsqr.js is the unminified 257 KB npm build; minify and add its licence (Apache-2.0) to docs.
* issues.file_id: queued (offline) reports cannot carry a photo; the sheet says so and saves the text.
