# Starter equipment templates (r2-av-librarian)

`starter-equipment-templates.json` — content export (format `avl-hub-content` v1), 14 SAMPLE records, one per category.
- Names: `SAMPLE – <Category> (template)`; manufacturer empty; category set.
- 19-21 field keys each, ALL `verify` with empty value (nothing invented). 11 common keys (asset_tag, serial_number, firmware_version, power_requirements, mounting, location_or_rack, cable_types, known_quirks, spares_and_consumables, manual_location, last_verified_notes) + 8-10 category keys.
- 7-8 generic Before/After install steps each, provenance `team`. No URLs, models, manufacturers, specs.
- Import: Admin > import content, or POST /api/admin/import {data, dry_run:true} first. Records arrive as Draft (never approved). Re-import is safe (ids already present are skipped).
- Use: Duplicate a template in your head: add real equipment, copy the keys you need, delete the rest. Importing again does not duplicate.
- Note: the spec table sorts keys alphabetically, so template order is not preserved.

`proto-units.js` + `test-units.js` — prototype of per-unit tracking (see report). `gen.js` regenerates the JSON (new UUIDs each run). `run.js` = import validation + screenshots.
