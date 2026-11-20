'use strict';
// The single list of things a role can be allowed to do. Every mutating route names exactly one of these (or 'any'/'public'),
// and the app refuses to start if a route names one that is not here. Reading is open to every signed-in person except where noted.
const CATALOGUE = [
  { key: 'equipment.edit', group: 'Equipment', label: 'Add and edit equipment', help: 'Equipment and its specifications, installation steps, photo panels and pins, and uploading photos and documents. Editing approved items returns them to Needs Review.' },
  { key: 'equipment.approve', group: 'Equipment', label: 'Approve equipment and photo panels', help: 'Makes material trusted. Includes approving with a VERIFY override.' },
  { key: 'equipment.delete', group: 'Equipment', label: 'Delete equipment and photo panels' },
  { key: 'files.delete', group: 'Equipment', label: 'Delete uploaded files' },
  { key: 'research.use', group: 'Equipment', label: 'Use web research and AI drafting', help: 'These use the paid search and AI services (limited per person per hour).' },
  { key: 'updates.record', group: 'Operations', label: 'Record updates and change their status', help: 'The app never installs anything; this only tracks it.' },
  { key: 'issues.write', group: 'Operations', label: 'Log issues and lessons learned', help: 'Can edit their own entries.' },
  { key: 'issues.manage', group: 'Operations', label: 'Edit anyone’s issues and lessons' },
  { key: 'training.take', group: 'Training', label: 'Take training', help: 'Quizzes and video checkpoints. People with this are the trainees: they appear in the skill matrix and can be scored and signed off.' },
  { key: 'training.author', group: 'Training', label: 'Create and edit training material', help: 'Modules, quizzes, practical skills, lesson videos and checkpoints. Can see quiz answers.' },
  { key: 'training.approve', group: 'Training', label: 'Approve training material' },
  { key: 'training.score', group: 'Training', label: 'Score practical skills (0–3)', help: 'Never your own.' },
  { key: 'training.signoff', group: 'Training', label: 'Sign off trainees', help: 'Never yourself, and only on approved material once the quiz and practical requirements are met.' },
  { key: 'progress.view_all', group: 'Training', label: 'See everyone’s training progress' },
  { key: 'users.manage', group: 'Administration', label: 'Manage people', help: 'Create accounts, reset passwords, unlock, disable, change roles and reset two-step sign-in — only for people with no more power than you, and only into roles with no more power than yours.' },
  { key: 'roles.manage', group: 'Administration', label: 'Manage roles and permissions', help: 'Can only grant permissions you hold yourself, and only change roles with no more power than yours.' },
  { key: 'sources.manage', group: 'Administration', label: 'Manage official source websites' },
  { key: 'audit.view', group: 'Administration', label: 'View the audit log' },
  { key: 'data.manage', group: 'Administration', label: 'Export and import content' },
];
const KEYS = CATALOGUE.map(p => p.key);
const ADMIN_KEYS = ['users.manage', 'roles.manage', 'sources.manage', 'audit.view', 'data.manage'];

// Built-in roles. "admin" always holds every permission (computed, so new permissions in future versions reach it automatically)
// and cannot be edited or deleted. The others behave exactly as they did before roles became editable, and can be reset to these.
const SYSTEM_ROLES = {
  admin: { name: 'Leader/Admin', description: 'Everything. Cannot be edited or removed.', permissions: KEYS, locked: true },
  trainer: { name: 'Trainer', description: 'Runs training: writes material, scores practicals, signs people off.',
    permissions: ['equipment.edit', 'files.delete', 'research.use', 'updates.record', 'issues.write', 'issues.manage', 'training.take', 'training.author', 'training.score', 'training.signoff', 'progress.view_all'] },
  technician: { name: 'Technician', description: 'Day-to-day use: equipment, issues, updates, and taking training.',
    permissions: ['equipment.edit', 'research.use', 'updates.record', 'issues.write', 'training.take'] },
  viewer: { name: 'Viewer', description: 'Read-only.', permissions: [] },
};
const isKey = k => KEYS.includes(k);
const subset = (a, b) => [...a].every(x => b.has(x));
module.exports = { CATALOGUE, KEYS, ADMIN_KEYS, SYSTEM_ROLES, isKey, subset };
