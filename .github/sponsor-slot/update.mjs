// sponsor-slot: rewrites the README's sponsor block from the approved calendar.
// Runs in this repo's GitHub Actions workflow. No dependencies, no secrets.
//
// - The calendar, merged into main by the maintainer, is the only source of
//   sponsors. The block is rendered from the template in this repo.
// - Every run decides from the current main, stages only README.md, never
//   force-pushes, and commits only when the block changes.
// - It prints one annotation per run: decision=no-change|commit|open|error.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALLOWED_ORIGIN = 'https://readme-sponsor-lab.helloericsf.workers.dev';
export const START = '<!-- sponsor-slot:start -->';
export const END = '<!-- sponsor-slot:end -->';
const SECTION_SPONSOR = '<!-- template:sponsor -->';
const SECTION_OPEN = '<!-- template:open -->';
export const FILES = {
  calendar: '.github/sponsor-slot/calendar.json',
  template: '.github/sponsor-slot/template.md',
  readme: 'README.md',
};
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const VERSION_RE = /^v[0-9]{1,4}$/;
// No Markdown or HTML syntax, no line breaks: safe in the text and the alt text.
const NAME_RE = /^[A-Za-z0-9 .,&'-]{1,60}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ENTRY_KEYS = new Set(['campaign_id', 'name', 'version', 'starts_at', 'ends_at']);
const PLACEHOLDERS = new Set(['campaign_id', 'name', 'version']);
const MAX_ENTRIES = 50;
const MAX_ATTEMPTS = 3;
const BOT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];

export class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg); };
const count = (text, part) => text.split(part).length - 1;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function parseTime(s, where) {
  if (typeof s !== 'string' || !TIME_RE.test(s)) refuse(`${where} must be YYYY-MM-DDTHH:MM:SSZ`);
  const t = Date.parse(s);
  // Rejects impossible dates such as 2026-02-30, which Date would roll over.
  if (Number.isNaN(t) || new Date(t).toISOString() !== s.replace('Z', '.000Z')) refuse(`${where} is not a real UTC time`);
  return t;
}

export function parseCalendar(text) {
  let cal;
  try { cal = JSON.parse(text); } catch { refuse('calendar is not JSON'); }
  if (!isObject(cal)) refuse('calendar is not an object');
  if (Object.keys(cal).sort().join(',') !== 'entries,schema') refuse('calendar keys must be exactly schema and entries');
  if (cal.schema !== 1) refuse('calendar schema must be 1');
  if (!Array.isArray(cal.entries) || cal.entries.length < 1 || cal.entries.length > MAX_ENTRIES) refuse(`calendar needs 1-${MAX_ENTRIES} entries`);
  const entries = cal.entries.map((e, i) => {
    const where = `calendar entry ${i}`;
    if (!isObject(e)) refuse(`${where} is not an object`);
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) refuse(`${where} has unknown key ${k}`);
    if (typeof e.campaign_id !== 'string' || !ID_RE.test(e.campaign_id)) refuse(`${where} has a bad campaign_id`);
    if (typeof e.version !== 'string' || !VERSION_RE.test(e.version)) refuse(`${where} has a bad version`);
    if (typeof e.name !== 'string' || !NAME_RE.test(e.name) || e.name.trim() !== e.name) {
      refuse(`${where} name must be 1-60 letters, digits, spaces or .,&'- with no outer spaces`);
    }
    const start = parseTime(e.starts_at, `${where} starts_at`);
    const end = 'ends_at' in e ? parseTime(e.ends_at, `${where} ends_at`) : null;
    if (end !== null && end <= start) refuse(`${where} ends_at must be after starts_at`);
    return { campaign_id: e.campaign_id, name: e.name, version: e.version, start, end };
  });
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].start <= entries[i - 1].start) refuse(`calendar entry ${i} must start after entry ${i - 1}`);
    if (entries[i - 1].end !== null && entries[i - 1].end > entries[i].start) refuse(`calendar entry ${i - 1} ends after entry ${i} starts`);
  }
  return entries;
}

// The entry live at `now`, or null (the slot is open). An entry runs until its
// ends_at, else until the next entry starts. An ended entry never falls back
// to an older one.
export function activeEntry(entries, now) {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const end = e.end ?? entries[i + 1]?.start ?? Infinity;
    if (e.start <= now && now < end) return e;
  }
  return null;
}

function checkUrls(section) {
  for (const [raw] of section.matchAll(/https?:\/\/[^\s)"'<>]+/g)) {
    let u;
    try { u = new URL(raw); } catch { refuse(`template URL does not parse: ${raw}`); }
    if (u.origin !== ALLOWED_ORIGIN || u.username || u.password) refuse(`template URL is outside ${ALLOWED_ORIGIN}: ${raw}`);
  }
}

export function parseTemplate(text) {
  if (count(text, SECTION_SPONSOR) !== 1 || count(text, SECTION_OPEN) !== 1) refuse('template needs one sponsor and one open section');
  const iSponsor = text.indexOf(SECTION_SPONSOR);
  const iOpen = text.indexOf(SECTION_OPEN);
  if (iOpen < iSponsor) refuse('template sponsor section must come first');
  const sponsor = text.slice(iSponsor + SECTION_SPONSOR.length, iOpen).trim();
  const open = text.slice(iOpen + SECTION_OPEN.length).trim();
  if (!sponsor || !open) refuse('template section is empty');
  for (const s of [sponsor, open]) if (s.includes(START) || s.includes(END)) refuse('template contains a slot marker');
  for (const [, key] of sponsor.matchAll(/\{\{([^}]*)\}\}/g)) if (!PLACEHOLDERS.has(key)) refuse(`template has unknown placeholder {{${key}}}`);
  if (open.includes('{{')) refuse('template open section takes no placeholders');
  checkUrls(sponsor);
  checkUrls(open);
  return { sponsor, open };
}

// A function replacement, so `$` in a value is never a replacement pattern.
export function renderBlock(template, entry) {
  if (!entry) return template.open;
  return template.sponsor.replace(/\{\{(campaign_id|name|version)\}\}/g, (_, key) => entry[key]);
}

export function replaceBlock(readme, block) {
  if (count(readme, START) !== 1 || count(readme, END) !== 1) refuse('README needs exactly one start and one end marker');
  const s = readme.indexOf(START);
  const e = readme.indexOf(END);
  if (e < s) refuse('README end marker comes before the start marker');
  const next = `\n${block}\n`;
  if (readme.slice(s + START.length, e) === next) return { changed: false, readme };
  return { changed: true, readme: readme.slice(0, s + START.length) + next + readme.slice(e) };
}

// GitHub workflow-command escaping, so a message is one annotation line.
const escapeCommand = (msg) => msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function realGit(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function run({ git = realGit, root = process.cwd(), now = Date.now, out = console.log } = {}) {
  const notice = (msg) => out(`::notice title=sponsor-slot::${escapeCommand(msg)}`);
  const error = (msg) => out(`::error title=sponsor-slot::${escapeCommand(msg)}`);
  const must = (args) => {
    const r = git(args);
    if (r.status !== 0) refuse(`git ${args.filter((a) => !a.includes('=')).join(' ')} failed: ${r.stderr.trim().slice(0, 300)}`);
    return r.stdout;
  };
  const read = (file) => readFileSync(join(root, file), 'utf8');
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Always decide from the current main, so a queued or retried run never
      // publishes from a stale snapshot.
      must(['fetch', '--depth=1', 'origin', 'main']);
      must(['reset', '--hard', 'FETCH_HEAD']);
      const entries = parseCalendar(read(FILES.calendar));
      const template = parseTemplate(read(FILES.template));
      const entry = activeEntry(entries, now());
      const label = entry ? `entry=${entry.campaign_id}/${entry.version}` : 'entry=open';
      const { changed, readme } = replaceBlock(read(FILES.readme), renderBlock(template, entry));
      if (!changed) {
        notice(`decision=no-change ${label} attempt=${attempt}`);
        return 0;
      }
      writeFileSync(join(root, FILES.readme), readme);
      must(['add', '--', FILES.readme]);
      const staged = must(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
      if (staged.length !== 1 || staged[0] !== FILES.readme) refuse(`staged files must be only ${FILES.readme}, got: ${staged.join(', ')}`);
      const message = entry ? `sponsor-slot: ${entry.name} (${entry.campaign_id}/${entry.version})` : 'sponsor-slot: slot open';
      must([...BOT, 'commit', '--quiet', '-m', message]);
      const push = git(['push', 'origin', 'HEAD:refs/heads/main']);
      if (push.status === 0) {
        notice(`decision=${entry ? 'commit' : 'open'} ${label} sha=${must(['rev-parse', 'HEAD']).trim()} attempt=${attempt}`);
        return 0;
      }
      // Someone else pushed first: decide again from the new main. Any other
      // rejection (a branch rule, permissions) is not retried.
      if (!/\[rejected\].*\((fetch first|non-fast-forward)\)/.test(push.stderr)) refuse(`push rejected: ${push.stderr.trim().slice(0, 300)}`);
    }
    refuse(`main kept moving; gave up after ${MAX_ATTEMPTS} attempts`);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    error(`decision=error reason=${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = run();
