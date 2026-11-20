'use strict';
// Edit time for last-writer-wins. Clients send X-Edit-Time (their clock corrected to the server's). We never trust it blindly:
// it is clamped to [now - 90 days, now], so a fast clock cannot win by claiming the future.
function editTime(req) {
  const raw = req.get && req.get('x-edit-time'); const now = Date.now();
  let t = raw ? Date.parse(raw) : NaN;
  if (Number.isNaN(t)) t = now;
  return new Date(Math.max(now - 90 * 864e5, Math.min(now, t))).toISOString();
}
// An edit is superseded only if the record was edited LATER than this edit was made. Ties go to the later arrival.
const superseded = (currentEditAt, at) => !!currentEditAt && at < currentEditAt;
module.exports = { editTime, superseded };
