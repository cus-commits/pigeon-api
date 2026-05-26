const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Persistent storage for reachouts
const REACHOUTS_DATA_FILE = path.join(__dirname, '.reachouts-data.json');
const REACHOUTS_CREDS_FILE = path.join(__dirname, '.reachouts-creds.json');

function loadReachoutsData() {
  try { return JSON.parse(fs.readFileSync(REACHOUTS_DATA_FILE, 'utf8')); }
  catch { return { messages: [], platformStatus: {}, lastSync: {} }; }
}
function saveReachoutsData(data) {
  try { fs.writeFileSync(REACHOUTS_DATA_FILE, JSON.stringify(data)); } catch (e) { console.error('[Reachouts] Save data error:', e.message); }
}
function loadReachoutsCreds() {
  try { return JSON.parse(fs.readFileSync(REACHOUTS_CREDS_FILE, 'utf8')); }
  catch { return { gmail: null, telegram: null, twitter: null, discord: null, linkedin: null }; }
}
function saveReachoutsCreds(creds) {
  try { fs.writeFileSync(REACHOUTS_CREDS_FILE, JSON.stringify(creds)); } catch (e) { console.error('[Reachouts] Save creds error:', e.message); }
}

const HARMONIC_BASE = 'https://api.harmonic.ai';
const HARMONIC_GQL = 'https://api.harmonic.ai/graphql';

// ───────── SUPER SEARCH STATE PERSISTENCE ─────────
// Without this, every Railway redeploy wipes _superSearchStatus and any
// in-progress or recently-completed scan results vanish. We persist to
// Railway's mounted volume (survives redeploys) so users don't lose work.
const SUPER_STATE_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'super_search_state.json');
let _superSaveTimer = null;
// Internal: write the current state to disk RIGHT NOW. Used by saveSuperStateNow()
// (for terminal transitions — done/cancelled/error/interrupted) and by the
// debounced variant for progress ticks.
function _writeSuperStateToDisk() {
  try {
    const state = global._superSearchStatus || {};
    // Retention windows: terminal scans (done/cancelled/error) kept 4h so the user
    // can revisit recent results after a refresh. In-flight scans always kept while
    // they're still in-flight. Other states pruned at 30 min.
    const now = Date.now();
    const TERMINAL_TTL = 4 * 60 * 60 * 1000;  // 4h
    const DEFAULT_TTL = 30 * 60 * 1000;        // 30m
    const fresh = {};
    for (const [k, v] of Object.entries(state)) {
      const t = v.finishedAt || v.startedAt || 0;
      const isTerminal = ['done', 'cancelled', 'error', 'interrupted'].includes(v.status);
      const isScanning = v.status === 'scanning';
      const ttl = isTerminal ? TERMINAL_TTL : DEFAULT_TTL;
      if (isScanning || (now - t < ttl)) fresh[k] = v;
    }
    fs.writeFileSync(SUPER_STATE_FILE, JSON.stringify(fresh));
  } catch (e) { console.error('[Super/persist] save error:', e.message); }
}

function saveSuperStateDebounced() {
  if (_superSaveTimer) return;
  _superSaveTimer = setTimeout(() => {
    _writeSuperStateToDisk();
    _superSaveTimer = null;
  }, 2000); // debounce 2s — protects against write storms during fast progress updates
}

// Immediate, synchronous write — call on terminal transitions (sendResult, cancel)
// so a Railway redeploy that hits within the 2s debounce window cannot lose results.
function saveSuperStateNow() {
  if (_superSaveTimer) { clearTimeout(_superSaveTimer); _superSaveTimer = null; }
  _writeSuperStateToDisk();
}
function restoreSuperState() {
  try {
    const raw = fs.readFileSync(SUPER_STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    // Mark any 'scanning' as 'interrupted' — they were definitely killed by the restart
    let interrupted = 0;
    for (const [k, v] of Object.entries(state)) {
      if (v.status === 'scanning') {
        v.status = 'interrupted';
        v.message = 'Scan was interrupted by a server restart. Please re-run with the same settings.';
        v.finishedAt = Date.now();
        interrupted++;
      }
    }
    global._superSearchStatus = state;
    console.log(`[Super/persist] Restored ${Object.keys(state).length} scan records (${interrupted} marked interrupted)`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Super/persist] restore error:', e.message);
    global._superSearchStatus = {};
  }
}
// Restore on module load (once per process start)
restoreSuperState();

// ───────── BACKBURN INDEX ─────────
// Global filter: companies marked "Backburn" never appear in any search result.
// Source-of-truth merged from three places:
//   1. Airtable CRM Stage = "Backburn"            (canonical, partner-facing)
//   2. backburn_registry.json (this file)         (everything sent through /api/vetting/backburn)
//   3. vetting_pipeline.json companies with c.backburned/c.dismissed (legacy)
// In-memory index = three Sets: normalized names, apex domains, harmonic IDs.
// Refresh: boot + every 5 min + on every mutation.
const BACKBURN_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'backburn_registry.json');
const _backburnIdx = { names: new Set(), domains: new Set(), ids: new Set() };
let _backburnLoadedAt = 0;
let _backburnRefreshing = false;

function normalizeBackburnName(s) {
  return (s || '').toString().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '').trim();
}
function extractApexDomain(s) {
  if (!s) return '';
  let d = String(s).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  // Strip a trailing port if present
  d = d.split(':')[0];
  return d;
}
function loadBackburnRegistry() {
  try {
    if (fs.existsSync(BACKBURN_FILE)) return JSON.parse(fs.readFileSync(BACKBURN_FILE, 'utf8'));
  } catch (e) { console.error('[Backburn] registry load error:', e.message); }
  return { companies: [] };
}
function saveBackburnRegistry(data) {
  try { fs.writeFileSync(BACKBURN_FILE, JSON.stringify(data)); }
  catch (e) { console.error('[Backburn] registry save error:', e.message); }
}
function addToBackburnIndex(entry) {
  if (!entry) return;
  const n = normalizeBackburnName(entry.name);
  if (n) _backburnIdx.names.add(n);
  const d = extractApexDomain(entry.website || entry.domain || '');
  if (d) _backburnIdx.domains.add(d);
  const id = String(entry.harmonic_id || entry.id || '').trim();
  if (id) _backburnIdx.ids.add(id);
}
function recordBackburn(entry) {
  // Persist to registry + warm in-memory index immediately.
  try {
    const reg = loadBackburnRegistry();
    const nameKey = normalizeBackburnName(entry.name);
    const exists = (reg.companies || []).find(c => normalizeBackburnName(c.name) === nameKey);
    if (!exists) {
      reg.companies.push({
        name: entry.name || '',
        harmonic_id: entry.harmonic_id || entry.id || null,
        website: entry.website || '',
        source: entry.source || 'vetting/backburn',
        backburnedBy: entry.backburnedBy || null,
        backburnedAt: Date.now(),
      });
      saveBackburnRegistry(reg);
    }
  } catch (e) { console.error('[Backburn] recordBackburn error:', e.message); }
  addToBackburnIndex(entry);
}
async function refreshBackburnIndex() {
  if (_backburnRefreshing) return;
  _backburnRefreshing = true;
  try {
    const names = new Set(), domains = new Set(), ids = new Set();
    // 1. Local registry
    try {
      const reg = loadBackburnRegistry();
      for (const c of (reg.companies || [])) {
        const n = normalizeBackburnName(c.name); if (n) names.add(n);
        const d = extractApexDomain(c.website || c.domain || ''); if (d) domains.add(d);
        const id = String(c.harmonic_id || c.id || '').trim(); if (id) ids.add(id);
      }
    } catch (e) { console.error('[Backburn] local registry merge error:', e.message); }
    // 2. Vetting pipeline backburned/dismissed (legacy)
    try {
      const vetRaw = fs.existsSync(path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'vetting_pipeline.json'))
        ? JSON.parse(fs.readFileSync(path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'vetting_pipeline.json'), 'utf8'))
        : { companies: [] };
      for (const c of (vetRaw.companies || [])) {
        if (!c.backburned && !c.dismissed) continue;
        const n = normalizeBackburnName(c.name); if (n) names.add(n);
        const d = extractApexDomain(c.website || c.domain || ''); if (d) domains.add(d);
        const id = String(c.harmonic_id || c.id || '').trim(); if (id) ids.add(id);
      }
    } catch (e) { /* file may not exist on fresh boot — fine */ }
    // 3. Airtable CRM Stage = "Backburn" (canonical)
    const token = process.env.AIRTABLE_TOKEN;
    const baseId = process.env.AIRTABLE_BASE_ID;
    if (token && baseId) {
      try {
        const tableName = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'All Companies');
        const formula = encodeURIComponent('{CRM Stage} = "Backburn"');
        // Page through (Airtable max 100 per page)
        let offset = null, page = 0, total = 0;
        do {
          let url = `https://api.airtable.com/v0/${baseId}/${tableName}?pageSize=100&filterByFormula=${formula}`;
          if (offset) url += `&offset=${encodeURIComponent(offset)}`;
          const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) { console.warn('[Backburn] Airtable refresh HTTP', r.status); break; }
          const data = await r.json();
          for (const rec of (data.records || [])) {
            const name = (rec.fields['Company'] || '').trim();
            const site = rec.fields['Company Link'] || rec.fields['Website'] || '';
            const hid = rec.fields['Harmonic ID'] || null;
            const n = normalizeBackburnName(name); if (n) names.add(n);
            const d = extractApexDomain(site); if (d) domains.add(d);
            const id = String(hid || '').trim(); if (id) ids.add(id);
            total++;
          }
          offset = data.offset || null;
          page++;
          if (page > 20) break; // hard safety
        } while (offset);
        console.log(`[Backburn] Airtable refresh: ${total} Backburn-stage records`);
      } catch (e) { console.warn('[Backburn] Airtable refresh error:', e.message); }
    }
    _backburnIdx.names = names;
    _backburnIdx.domains = domains;
    _backburnIdx.ids = ids;
    _backburnLoadedAt = Date.now();
    console.log(`[Backburn] Index refreshed: ${names.size} names / ${domains.size} domains / ${ids.size} ids`);
  } finally {
    _backburnRefreshing = false;
  }
}
function isBackburned(card) {
  if (!card) return false;
  const n = normalizeBackburnName(card.name || card.title || card.companyName);
  if (n && _backburnIdx.names.has(n)) return true;
  const site = card.website || card.url || card.domain || card.meta?.website || '';
  const d = extractApexDomain(site);
  if (d && _backburnIdx.domains.has(d)) return true;
  // Harmonic IDs may appear as bare id, or hm-12345 (super search signal id), or hash_id
  let rawId = card.harmonic_id ?? card.id ?? card.harmonicId ?? null;
  if (rawId != null) {
    const idStr = String(rawId);
    if (_backburnIdx.ids.has(idStr)) return true;
    if (idStr.startsWith('hm-') && _backburnIdx.ids.has(idStr.slice(3))) return true;
  }
  return false;
}
function filterBackburn(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return cards || [];
  if (_backburnIdx.names.size + _backburnIdx.domains.size + _backburnIdx.ids.size === 0) return cards;
  const out = [];
  let dropped = 0;
  for (const c of cards) {
    if (isBackburned(c)) { dropped++; continue; }
    out.push(c);
  }
  if (dropped > 0) console.log(`[Backburn] Filtered ${dropped}/${cards.length} backburned from results`);
  return out;
}
// Background refresh every 5 min (Airtable is the only externally-mutated source)
setInterval(() => { refreshBackburnIndex().catch(e => console.error('[Backburn] periodic refresh error:', e.message)); }, 5 * 60 * 1000);

// ───────── PER-USER HIDE-FOR-ME ─────────
// User-scoped opt-out. Whereas Backburn removes a company for everyone, hide-for-me
// only hides it from THAT user's future search results.
// Stored separately from `autoscan_seen.json` (which is for dismissed scan candidates)
// so the two semantics don't collide.
const USER_HIDDEN_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'user_hidden.json');
const _userHiddenCache = { data: null, loadedAt: 0 };
function loadUserHidden() {
  // 30-second cache — re-read on demand to pick up new hides without restart
  if (_userHiddenCache.data && Date.now() - _userHiddenCache.loadedAt < 30 * 1000) return _userHiddenCache.data;
  try {
    if (fs.existsSync(USER_HIDDEN_FILE)) {
      _userHiddenCache.data = JSON.parse(fs.readFileSync(USER_HIDDEN_FILE, 'utf8'));
    } else {
      _userHiddenCache.data = {};
    }
  } catch (e) {
    console.error('[UserHidden] load error:', e.message);
    _userHiddenCache.data = {};
  }
  _userHiddenCache.loadedAt = Date.now();
  return _userHiddenCache.data;
}
function saveUserHidden(data) {
  try { fs.writeFileSync(USER_HIDDEN_FILE, JSON.stringify(data)); _userHiddenCache.data = data; _userHiddenCache.loadedAt = Date.now(); }
  catch (e) { console.error('[UserHidden] save error:', e.message); }
}
function buildUserHideIndex(personId) {
  if (!personId) return null;
  const all = loadUserHidden();
  const entries = all[personId.toLowerCase()] || [];
  const names = new Set(), domains = new Set(), ids = new Set();
  for (const e of entries) {
    const n = normalizeBackburnName(e.name); if (n) names.add(n);
    const d = extractApexDomain(e.website || ''); if (d) domains.add(d);
    const id = String(e.harmonic_id || '').trim(); if (id) ids.add(id);
  }
  return { names, domains, ids, count: entries.length };
}
function isHiddenForUser(card, hideIdx) {
  if (!hideIdx || (hideIdx.names.size + hideIdx.domains.size + hideIdx.ids.size === 0)) return false;
  const n = normalizeBackburnName(card.name || card.title || card.companyName);
  if (n && hideIdx.names.has(n)) return true;
  const site = card.website || card.url || card.domain || card.meta?.website || '';
  const d = extractApexDomain(site);
  if (d && hideIdx.domains.has(d)) return true;
  let rawId = card.harmonic_id ?? card.id ?? card.harmonicId ?? null;
  if (rawId != null) {
    const idStr = String(rawId);
    if (hideIdx.ids.has(idStr)) return true;
    if (idStr.startsWith('hm-') && hideIdx.ids.has(idStr.slice(3))) return true;
  }
  return false;
}
function filterUserHidden(cards, hideIdx) {
  if (!hideIdx || !Array.isArray(cards) || cards.length === 0) return cards || [];
  if (hideIdx.names.size + hideIdx.domains.size + hideIdx.ids.size === 0) return cards;
  const out = [];
  let dropped = 0;
  for (const c of cards) {
    if (isHiddenForUser(c, hideIdx)) { dropped++; continue; }
    out.push(c);
  }
  if (dropped > 0) console.log(`[UserHidden] Filtered ${dropped}/${cards.length} hidden for user`);
  return out;
}
// Resolve personId from request: header `x-user-id` > query `personId` > body `personId`
function resolvePersonId(req) {
  return (req.headers['x-user-id'] || req.query.personId || req.body?.personId || '').toString().trim() || null;
}

// ───────── MERIT SCORING (5-dimension framework) ─────────
// Spec: anchor is a SEARCH filter, not a scoring template. Score on absolute
// investment merit: pedigree, traction, capital efficiency, investor quality,
// defensibility. Auto-modifiers applied deterministically. Anchor sanity-check
// ceiling prevents doppelganger inflation.
const MERIT_WEIGHTS = { pedigree: 0.25, traction: 0.25, capital: 0.20, investor: 0.15, defensibility: 0.15 };
const MERIT_MODIFIER_VALUES = {
  // Downgrades
  equity_crowdfunding_only: -1.0,
  stale_series_a: -1.0,
  shrinking_post_seed: -1.0,
  founder_moved: -1.5,
  headcount_mismatch: -0.5,
  buzzword_soup: -1.0,
  // Upgrades
  repeat_investor: 0.5,
  quantified_roi: 0.5,
  strategic_distribution: 0.5,
  patent_lab_ip: 0.5,
  major_award: 0.25,
  tier1_academic_equity: 0.25,
};
function computeWeightedScore(v) {
  return (v.pedigree || 0) * MERIT_WEIGHTS.pedigree
    + (v.traction || 0) * MERIT_WEIGHTS.traction
    + (v.capital || 0) * MERIT_WEIGHTS.capital
    + (v.investor || 0) * MERIT_WEIGHTS.investor
    + (v.defensibility || 0) * MERIT_WEIGHTS.defensibility;
}
function applyModifiers(modifiers) {
  if (!Array.isArray(modifiers)) return 0;
  const sum = modifiers.reduce((s, m) => s + (MERIT_MODIFIER_VALUES[m] || 0), 0);
  return Math.max(-2, Math.min(2, sum));
}
// Anchor sanity check: company can only exceed anchor if it beats anchor on
// at least one sub-dimension by >=1 point. Otherwise cap to anchor score.
function applyAnchorCeiling(companyDims, finalScore, anchorRating) {
  if (!anchorRating || finalScore <= anchorRating.final) return { final: finalScore, capped: false };
  const beatsAnchor = ['pedigree', 'traction', 'capital', 'investor', 'defensibility']
    .some(d => (companyDims[d] || 0) >= (anchorRating[d] || 0) + 1);
  if (beatsAnchor) return { final: finalScore, capped: false };
  return { final: anchorRating.final, capped: true };
}
function buildMeritPrompt({ companies, anchorContext, additionalInfo, isAnchorSelfRating, anchorName, anchorRatings }) {
  const anchorBlock = isAnchorSelfRating
    ? `You are rating the ANCHOR company "${anchorName}" itself, on its own standalone investment merit. This score becomes the sanity-check ceiling for similar companies.`
    : (anchorContext ? `\nSEARCH SCOPE — User asked us to find companies similar to these baselines. This defines WHAT we searched for, NOT how to score:\n${anchorContext}\n⚠ CRITICAL: These signals are ALREADY filtered to be similar. Similarity is a given — do NOT give similarity bonus points. Score each company on its OWN absolute merit.` : '');

  const anchorRatingsBlock = (!isAnchorSelfRating && anchorRatings && Object.keys(anchorRatings).length > 0)
    ? `\nANCHOR STANDALONE RATINGS (sanity-check ceilings):\n${Object.entries(anchorRatings).map(([k, v]) => `${k}: ${v.final.toFixed(1)}/10 (P${v.pedigree} T${v.traction} C${v.capital} I${v.investor} D${v.defensibility})`).join('\n')}\nA company that merely resembles the anchor cannot exceed the anchor's score. Score on merit; the code will enforce the ceiling.`
    : '';

  return `You are a senior deal partner at Daxos Capital evaluating Pre-Seed/Seed investments ($100K-$250K checks).
${anchorBlock}${anchorRatingsBlock}${additionalInfo ? `\n\nADDITIONAL CONTEXT FROM USER:\n${additionalInfo}\n` : ''}

Rate each company below on 5 DIMENSIONS (0-10 each), then list applicable AUTO-MODIFIERS, then give a 2-3 sentence bottom line.

DIMENSIONS:
1. Founder Pedigree (25% weight) — repeat founder/prior exit (9-10), top-tier alumni + technical co-founder (7-8), notable accelerator/family operator (5-6), generic credentials (3-4), solo no track record (1-2). If team data is unavailable, score 4 (NEUTRAL — do NOT penalize when company is otherwise sound/novel).
2. Customer Traction (25% weight) — documented multi-$M ROI in trade press (9-10), named blue-chip enterprises + quantified outcomes (7-8), multiple paying customers + public testimonials (5-6), pilots in progress (3-4), pre-revenue (1-2), no commercial customers visible (0).
3. Capital Efficiency (20% weight) — real revenue + named customers on small raise (9-10), reasonable headcount + multi-country + verifiable revenue (7-8), proportionate burn (5-6), red flags like high HC no revenue (3-4), unsustainable burn (1-2).
4. Investor Quality (15% weight) — Tier-1 specialist VC (a16z, Founders Fund, Sequoia, First Round) or strategic corporate where the corporate's portfolio IS the distribution (9-10), reputable regional VC + multiple institutional follow-ons (7-8), solid regional VC/accelerators/gov funds (5-6), angel rounds + small accelerators (3-4), EQUITY CROWDFUNDING WITHOUT INSTITUTIONAL ROUND (1-2 — this means VCs declined). Friends/family or undisclosed (0).
5. Defensibility/Moat (15% weight) — patent-protected proprietary tech rooted in top-tier university lab (9-10), strong IP + technical first-mover + hard-to-replicate data assets (7-8), differentiated product but commodity hardware (5-6), generic IoT/cloud no IP (3-4), pure aggregation no defensible asset (1-2).

CALIBRATION: Most companies should land 4-6 on most dimensions. Reserve 8+ for genuinely exceptional. A 9 means "I'd write the check now."

AUTO-MODIFIERS — list applicable string IDs in a "modifiers" array. Code applies the math.
DOWNGRADES: equity_crowdfunding_only (-1.0), stale_series_a (-1.0), shrinking_post_seed (-1.0), founder_moved (-1.5), headcount_mismatch (-0.5), buzzword_soup (-1.0)
UPGRADES: repeat_investor (+0.5), quantified_roi (+0.5), strategic_distribution (+0.5), patent_lab_ip (+0.5), major_award (+0.25), tier1_academic_equity (+0.25)

OUTPUT — strict JSON in a code block, then nothing else:
${'```'}json
{
  "ExactCompanyName": {
    "pedigree": 6, "pedigree_reason": "one-line justification",
    "traction": 5, "traction_reason": "...",
    "capital": 6, "capital_reason": "...",
    "investor": 4, "investor_reason": "...",
    "defensibility": 5, "defensibility_reason": "...",
    "modifiers": ["equity_crowdfunding_only"],
    "bottom_line": "2-3 sentences on the actual investment thesis. What's the case to write a check? What's the case to pass?"
  }
}
${'```'}

COMPANIES TO RATE:
${companies.join('\n\n---\n\n')}`;
}

function domainsConflict(domainA, domainB) {
  if (!domainA || !domainB) return false;
  if (domainA === domainB) return false;
  if (domainA.includes(domainB) || domainB.includes(domainA)) return false;
  const commonTlds = new Set(['com','io','ai','xyz','co','gg','fi','app','org','net','dev','sh','us','uk','de','fun']);
  function baseName(d) {
    const parts = d.split('.');
    const tld = parts[parts.length - 1];
    const base = commonTlds.has(tld) ? parts.slice(0, -1).join('') : parts.join('');
    return base.replace(/^(app|get|use|try|pay|my|www|go)/, '');
  }
  const baseA = baseName(domainA);
  const baseB = baseName(domainB);
  if (baseA && baseB && baseA.length >= 3 && baseB.length >= 3) {
    if (baseA === baseB) return false;
    const shorter = baseA.length <= baseB.length ? baseA : baseB;
    const longer = baseA.length <= baseB.length ? baseB : baseA;
    if (longer.includes(shorter) && shorter.length >= longer.length * 0.6) return false;
  }
  return true;
}

// ==========================================
// GRAPHQL ENRICHMENT — Scout-quality data
// ==========================================

const COMPANY_GQL_QUERY = `query GetCompaniesByIds($ids: [Int!]!) {
  getCompaniesByIds(ids: $ids) {
    id
    entityUrn
    name
    logoUrl
    description
    shortDescription
    externalDescription
    legalName
    website { url domain }
    location { city state country }
    foundingDate { date }
    funding {
      fundingTotal
      numFundingRounds
      lastFundingAt
      lastFundingType
      lastFundingTotal
      fundingStage
    }
    headcount
    webTraffic
    tractionMetrics {
      webTraffic {
        latestMetricValue
        ago14d { percentChange value }
        ago30d { percentChange value }
        ago90d { percentChange value }
      }
      headcount {
        latestMetricValue
        ago30d { percentChange }
        ago90d { percentChange }
      }
      headcountEngineering {
        latestMetricValue
        ago30d { percentChange }
        ago90d { percentChange }
      }
      twitterFollowerCount {
        latestMetricValue
        ago30d { percentChange }
      }
      linkedinFollowerCount {
        latestMetricValue
        ago30d { percentChange }
      }
    }
    customerType
    stage
    ownershipStatus
    initializedDate
    updatedAt
    socials {
      linkedin { url followerCount }
      twitter { url followerCount }
      crunchbase { url }
      pitchbook { url }
    }
    tagsV2 { displayValue type }
    highlights { category text }
    employeeHighlights { category text }
    investorBadges { investorUrn isLead logoUrl name }
    person_relationships_founders_and_ceos: employees(
      employeeSearchInput: {employeeGroupType: FOUNDERS_AND_CEO, employeeStatus: ACTIVE, pagination: {start: 0, pageSize: 5}}
    ) {
      firstName lastName fullName profilePictureUrl entityUrn id
      socials { linkedin { url } }
    }
    person_relationships_executives: employees(
      employeeSearchInput: {employeeGroupType: EXECUTIVES, employeeStatus: ACTIVE, pagination: {start: 0, pageSize: 5}}
    ) {
      firstName lastName fullName profilePictureUrl entityUrn id
      socials { linkedin { url } }
    }
    leadership_prior_companies: employeesCompanies(
      employeeSearchInput: {employeeGroupType: LEADERSHIP, employeeStatus: ACTIVE}
    ) {
      lastCompanies(paginationInput: {first: 10}) {
        edges { node { id name logoUrl } }
      }
    }
  }
}`;

// Batch enrich companies via GraphQL — returns Scout-quality data
// Falls back to REST if GQL fails
async function gqlEnrichCompanies(companyIds, apiKey) {
  if (!companyIds.length) return [];
  const numericIds = companyIds.map(id => {
    if (typeof id === 'number') return id;
    const n = parseInt(id);
    return isNaN(n) ? null : n;
  }).filter(Boolean);

  if (!numericIds.length) return [];

  // Try GraphQL first
  try {
    const res = await fetch(HARMONIC_GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey,
      },
      body: JSON.stringify({
        operationName: 'GetCompaniesByIds',
        query: COMPANY_GQL_QUERY,
        variables: { ids: numericIds },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data?.data?.getCompaniesByIds?.length > 0) {
        const companies = data.data.getCompaniesByIds;
        console.log(`[GQL] Enriched ${companies.length}/${numericIds.length} companies via GraphQL`);
        return companies;
      }
      if (data?.errors) {
        console.error(`[GQL] GraphQL errors:`, JSON.stringify(data.errors).slice(0, 300));
      }
    } else {
      const errBody = await res.text().catch(() => '');
      console.error(`[GQL] HTTP ${res.status} — ${errBody.slice(0, 500)} — falling back to REST`);
    }
  } catch (e) {
    console.error('[GQL] Error:', e.message, '— falling back to REST');
  }

  // Fallback: REST enrichment (individual calls)
  console.log(`[GQL] Falling back to REST for ${numericIds.length} companies`);
  const results = [];
  const batchSize = 10;
  for (let i = 0; i < numericIds.length; i += batchSize) {
    const batch = numericIds.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(id =>
        fetch(`${HARMONIC_BASE}/companies/${id}`, { headers: { apikey: apiKey } })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value);
    }
    if (i + batchSize < numericIds.length) await new Promise(r => setTimeout(r, 200));
  }
  console.log(`[GQL] REST fallback got ${results.length}/${numericIds.length} companies`);
  return results;
}

// Normalize GQL company to our standard card format
// Normalize company data to card format — handles both GQL and REST responses
function gqlToCard(c) {
  // Detect if this is REST format (has funding.funding_total) or GQL format (has funding.fundingTotal)
  const isREST = !!(c.funding?.funding_total !== undefined || c.logo_url || c.founding_date);

  const f = c.funding || {};
  const tm = c.tractionMetrics || {};

  // Rich founder extraction (GQL format with experience)
  const rawFounders = c.person_relationships_founders_and_ceos || c.people || [];
  const founders = rawFounders.map(p => {
    if (typeof p === 'string') return { name: p, linkedin: '', pfp: '', careerPath: '', priorCompanies: [], experience: [], education: [], highlights: [] };
    const exp = (p.experience || p.positions || []).map(e => ({
      company: e.company?.name || e.companyName || '',
      title: e.title || '',
      startDate: e.startDate || e.start_date || null,
      endDate: e.endDate || e.end_date || null,
      isCurrent: !!e.isCurrentRole || !!e.is_current,
    })).filter(e => e.company);
    const edu = (p.education || []).map(e => ({
      school: e.school?.name || e.schoolName || '',
      field: e.fieldOfStudy || e.field_of_study || '',
      degree: e.degreeType || e.degree_type || '',
    })).filter(e => e.school);
    const highlights = (p.highlights || []).map(h => typeof h === 'string' ? h : h.text).filter(Boolean);
    const priorRoles = exp.filter(e => !e.isCurrent).slice(0, 5);
    const careerPath = priorRoles.map(e => `${e.title} @ ${e.company}`).join(' → ');
    return {
      name: p.fullName || p.full_name || `${p.firstName || p.first_name || ''} ${p.lastName || p.last_name || ''}`.trim(),
      linkedin: p.socials?.linkedin?.url || p.linkedin_url || '',
      pfp: p.profilePictureUrl || p.profile_picture_url || '',
      headline: p.linkedinHeadline || p.linkedin_headline || '',
      about: (p.about || '').slice(0, 200),
      experience: exp.slice(0, 8),
      education: edu.slice(0, 3),
      highlights: highlights.slice(0, 3),
      careerPath,
      priorCompanies: priorRoles.map(e => e.company),
    };
  }).filter(p => p.name);

  const rawExecs = c.person_relationships_executives || [];
  const executives = rawExecs.map(p => {
    if (typeof p === 'string') return { name: p, linkedin: '', priorCompanies: [] };
    const exp = (p.experience || []).filter(e => !e.isCurrentRole).slice(0, 3);
    return {
      name: p.fullName || p.full_name || `${p.firstName || ''} ${p.lastName || ''}`.trim(),
      linkedin: p.socials?.linkedin?.url || '',
      headline: p.linkedinHeadline || '',
      priorCompanies: exp.map(e => e.company?.name).filter(Boolean),
    };
  }).filter(p => p.name);

  const priorCompanies = (c.leadership_prior_companies?.lastCompanies?.edges || [])
    .map(e => e.node?.name).filter(Boolean);
  
  // Investors — handle both formats
  let investors = [];
  let leadInvestors = [];
  if (c.investorBadges) {
    investors = c.investorBadges.map(i => ({ name: i.name, isLead: i.isLead }));
    leadInvestors = investors.filter(i => i.isLead).map(i => i.name);
  } else if (f.investors) {
    investors = (f.investors || []).map(i => ({ name: typeof i === 'string' ? i : (i.name || i.investorName || ''), isLead: !!i.isLead }));
    leadInvestors = investors.filter(i => i.isLead).map(i => i.name);
  }

  const highlights = (c.highlights || []).map(h => typeof h === 'string' ? h : h.text).filter(Boolean);
  const empHighlights = (c.employeeHighlights || c.employee_highlights || []).map(h => typeof h === 'string' ? h : h.text).filter(Boolean);
  const allFounderPriors = [...new Set(founders.flatMap(f => f.priorCompanies))];

  // Handle both REST and GQL field names
  const fundingTotal = f.fundingTotal || f.funding_total || null;
  const fundingStage = f.fundingStage || f.lastFundingType || f.last_funding_type || f.funding_stage || c.stage || null;
  const fundingDate = (f.lastFundingAt || f.last_funding_at || '').toString().slice(0, 10) || null;
  const lastRoundAmt = f.lastFundingTotal || f.last_funding_total || null;
  const numRounds = f.numFundingRounds || f.num_funding_rounds || null;

  const website = c.website?.url || c.website?.domain || (typeof c.website === 'string' ? c.website : null);
  const logoUrl = c.logoUrl || c.logo_url || null;
  const founded = c.foundingDate?.date ? c.foundingDate.date.slice(0, 4) : (c.founding_date ? String(c.founding_date).slice(0, 4) : null);

  let location = null;
  if (c.location) {
    if (typeof c.location === 'string') location = c.location;
    else location = [c.location.city, c.location.state, c.location.country].filter(Boolean).join(', ');
  }

  const tags = (c.tagsV2 || c.tags_v2 || c.tags || []).map(t => typeof t === 'string' ? t : (t.displayValue || t.tag_value || t.name || '')).filter(Boolean);

  return {
    id: c.id,
    name: c.name || c.legal_name || c.legalName || '?',
    description: (c.description || c.shortDescription || c.short_description || c.externalDescription || c.external_description || '').slice(0, 400),
    logo_url: logoUrl,
    website,
    founded,
    headcount: c.headcount || c.employee_count || null,
    ownership_status: c.ownershipStatus || c.ownership_status || null,
    location,
    funding_total: fundingTotal,
    funding_stage: fundingStage,
    funding_date: fundingDate,
    last_round_amount: lastRoundAmt,
    num_rounds: numRounds,
    investors: investors.map(i => i.name).filter(Boolean).slice(0, 8),
    lead_investors: leadInvestors,
    socials: {
      linkedin: c.socials?.linkedin?.url || (typeof c.socials?.linkedin === 'string' ? c.socials.linkedin : null),
      twitter: c.socials?.twitter?.url || (typeof c.socials?.twitter === 'string' ? c.socials.twitter : null),
      crunchbase: c.socials?.crunchbase?.url || null,
    },
    tags: tags.slice(0, 8),
    highlights: highlights.slice(0, 5),
    employee_highlights: empHighlights.slice(0, 3),
    founders,
    executives: executives.slice(0, 3),
    prior_companies: priorCompanies.length > 0 ? priorCompanies.slice(0, 10) : allFounderPriors.slice(0, 10),
    founder_prior_companies: allFounderPriors,
    traction: {
      webTraffic: c.webTraffic || c.web_traffic || null,
      webGrowth30d: tm.webTraffic?.ago30d?.percentChange || null,
      webGrowth90d: tm.webTraffic?.ago90d?.percentChange || null,
      hcGrowth30d: tm.headcount?.ago30d?.percentChange || null,
      hcGrowth90d: tm.headcount?.ago90d?.percentChange || null,
      engGrowth30d: tm.headcountEngineering?.ago30d?.percentChange || null,
      engGrowth90d: tm.headcountEngineering?.ago90d?.percentChange || null,
      twitterGrowth30d: tm.twitterFollowerCount?.ago30d?.percentChange || null,
      linkedinGrowth30d: tm.linkedinFollowerCount?.ago30d?.percentChange || null,
    },
    twitter_followers: c.socials?.twitter?.followerCount || null,
    linkedin_followers: c.socials?.linkedin?.followerCount || null,
    initialized_date: c.initializedDate || c.initialized_date || c.created_at || null,
    updated_at: c.updatedAt || c.updated_at || null,
  };
}

// Enhanced search: search_agent + keyword search combined, then GQL enrich
async function enhancedSearch(query, apiKey, { size = 50, keywords = null, antiKeywords = null } = {}) {
  const authHeaders = { apikey: apiKey };
  const allIds = new Set();

  // 1. Natural language search
  try {
    const r = await fetch(`${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(query)}&size=${Math.min(size, 1000)}`, { headers: authHeaders });
    if (r.ok) {
      const data = await r.json();
      (data.results || []).forEach(r => {
        const id = r.id || (r.urn || r.entity_urn || '').split(':').pop();
        if (id) allIds.add(String(id));
      });
      console.log(`[EnhSearch] search_agent "${query.slice(0, 40)}" → ${allIds.size} results`);
    }
  } catch (e) { console.error('[EnhSearch] search_agent error:', e.message); }

  // 2. Keyword search (deprecated but powerful for boolean filtering)
  if (keywords || antiKeywords) {
    try {
      const params = new URLSearchParams({ size: String(Math.min(size, 100)), include_ids_only: 'true' });
      if (keywords) params.set('contains_any_of_keywords', keywords);
      if (antiKeywords) params.set('does_not_contain_keywords', antiKeywords);
      const r = await fetch(`${HARMONIC_BASE}/search/companies_by_keywords?${params}`, { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' } });
      if (r.ok) {
        const data = await r.json();
        const ids = data.results || [];
        ids.forEach(id => {
          const idStr = typeof id === 'object' ? (id.id || (id.urn || '').split(':').pop()) : String(id);
          if (idStr) allIds.add(idStr);
        });
        console.log(`[EnhSearch] keyword search → ${ids.length} additional (total: ${allIds.size})`);
      }
    } catch (e) { console.error('[EnhSearch] keyword error:', e.message); }
  }

  if (allIds.size === 0) return [];

  // 3. GQL enrich
  const idsToEnrich = [...allIds].slice(0, size);
  const enriched = await gqlEnrichCompanies(idsToEnrich, apiKey);
  return enriched.map(c => gqlToCard(c));
}

const SYSTEM_PROMPT = `You are Pigeon Finder, an AI deal analyst for Daxos Capital. You analyze companies sourced from Harmonic.ai's database of 30M+ companies and 190M+ professional profiles.

FUND PROFILE:
- Check size: $100K–$250K
- Focus sectors: Crypto/Web3, Fintech, Climate-Tech, Consumer
- Stage: Primarily Pre-Seed and Seed
- Key decision factors: team quality, market timing, traction signals, defensibility, valuation reasonableness

ANALYSIS STYLE:
- Be direct, opinionated, and concise — like a sharp associate briefing the IC
- Use concrete numbers and comparisons when available
- Flag both strengths and red flags clearly
- Score companies 1–10 on Daxos fit when asked
- Consider valuation relative to traction
- Pay attention to: revenue/ARR signals, token economics for crypto deals, TAM, competitive landscape, founder track record
- When you see SIMILAR COMPANIES data, compare them against the target and highlight which ones are most differentiated
- When you see PEOPLE SEARCH data, identify which founders/people are most relevant and what their current companies do
- When you see traction metrics (web traffic %, headcount growth %), call out which companies show momentum

IMPORTANT: The data sections below contain REAL data from Harmonic's database. Data may include:
- COMPANY DATA: Standard search results
- SIMILAR COMPANIES: Companies found via similarity search
- PEOPLE SEARCH RESULTS: Founders/people matching a background query
- TARGET COMPANY: A specific company the user asked about

Your job is to:
1. Filter and narrow down based on what the user asked
2. Rank the most relevant ones
3. Analyze with specifics — cite actual funding, team size, descriptions, investors, founder backgrounds
4. Call out missing data and suggest DD steps

When listing companies, always bold the company name like **CompanyName** so the UI can extract it for the favorites feature.

Keep responses mobile-friendly — short paragraphs, no walls of text. Lead with the best matches.`;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-harmonic-key', 'x-anthropic-key', 'x-scan-tier', 'x-user-id'],
}));
app.use(express.json({ limit: '5mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'pigeon-finder-api' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Check if server has API keys configured
app.get('/api/status', (req, res) => {
  const hKey = process.env.HARMONIC_API_KEY || '';
  const aKey = process.env.ANTHROPIC_API_KEY || '';
  res.json({
    hasHarmonicKey: !!hKey,
    maskedHarmonicKey: hKey ? hKey.slice(0, 6) + '...' + hKey.slice(-4) : '',
    hasAnthropicKey: !!aKey,
    maskedAnthropicKey: aKey ? aKey.slice(0, 8) + '...' + aKey.slice(-4) : '',
  });
});

// Validate API keys
app.post('/api/validate-key', async (req, res) => {
  const { type, key } = req.body;

  if (type === 'harmonic') {
    try {
      const r = await fetch(`${HARMONIC_BASE}/search/typeahead?query=stripe&size=1`, {
        headers: { 'apikey': key },
      });
      if (r.ok) return res.json({ valid: true });
      return res.json({ valid: false, error: `HTTP ${r.status}` });
    } catch (e) {
      return res.json({ valid: false, error: e.message });
    }
  }

  if (type === 'anthropic') {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      if (r.ok || r.status === 200) return res.json({ valid: true });
      return res.json({ valid: false, error: `HTTP ${r.status}` });
    } catch (e) {
      return res.json({ valid: false, error: e.message });
    }
  }

  res.json({ valid: false, error: 'Unknown key type' });
});

// ==========================================
// SHARED FAVORITES SYSTEM
// ==========================================
const SHARED_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'shared_favorites.json');

function loadShared() {
  try {
    if (fs.existsSync(SHARED_FILE)) {
      return JSON.parse(fs.readFileSync(SHARED_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load shared favorites:', e.message);
  }
  return { favorites: [], users: {} };
}

function saveShared(data) {
  try {
    fs.writeFileSync(SHARED_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save shared favorites:', e.message);
  }
}

// Get all shared favorites
app.get('/api/shared/favorites', (req, res) => {
  const data = loadShared();
  res.json({ favorites: data.favorites, users: data.users });
});

// Add a shared favorite
app.post('/api/shared/favorites', (req, res) => {
  const { user_id, nickname, company } = req.body;
  if (!user_id || !company?.name) {
    return res.status(400).json({ error: 'user_id and company.name required' });
  }

  const data = loadShared();

  // Update user nickname
  if (nickname) {
    data.users[user_id] = { nickname, last_seen: new Date().toISOString() };
  }

  // Check if this company is already shared by this user
  const existing = data.favorites.find(
    (f) => f.company.name === company.name && f.user_id === user_id
  );

  if (!existing) {
    data.favorites.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      user_id,
      nickname: nickname || data.users[user_id]?.nickname || 'Anonymous Pigeon',
      company,
      shared_at: new Date().toISOString(),
    });
  }

  saveShared(data);
  res.json({ success: true, total: data.favorites.length });
});

// Remove a shared favorite
app.delete('/api/shared/favorites', (req, res) => {
  const { user_id, company_name, remove_all } = req.body;
  if (!company_name) {
    return res.status(400).json({ error: 'company_name required' });
  }

  const data = loadShared();
  if (remove_all) {
    // Admin: remove this company from ALL users
    data.favorites = data.favorites.filter(
      (f) => f.company.name !== company_name
    );
  } else if (user_id) {
    // Remove only this user's share
    data.favorites = data.favorites.filter(
      (f) => !(f.company.name === company_name && f.user_id === user_id)
    );
  }
  saveShared(data);
  res.json({ success: true, total: data.favorites.length });
});

// Vote on a shared favorite (in/out)
app.post('/api/shared/favorites/vote', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { companyName, voter, vote } = req.body; // vote: 'in' | 'out'
  if (!companyName || !voter || !vote) return res.status(400).json({ error: 'companyName, voter, vote required' });

  const data = loadShared();
  const matches = data.favorites.filter(f => f.company?.name === companyName);
  if (matches.length === 0) return res.status(404).json({ error: 'Company not found in favorites' });

  for (const fav of matches) {
    if (!fav.votes) fav.votes = {};
    fav.votes[voter] = vote;
    const allVotes = Object.values(fav.votes);
    fav.backburned = allVotes.length > 0 && allVotes.every(v => v === 'out');
  }

  saveShared(data);
  res.json({ success: true, votes: matches[0]?.votes || {} });
});

// Update user nickname
app.post('/api/shared/nickname', (req, res) => {
  const { user_id, nickname } = req.body;
  if (!user_id || !nickname) {
    return res.status(400).json({ error: 'user_id and nickname required' });
  }

  const data = loadShared();
  data.users[user_id] = { nickname, last_seen: new Date().toISOString() };

  // Also update nickname on all their existing favorites
  data.favorites.forEach((f) => {
    if (f.user_id === user_id) f.nickname = nickname;
  });

  saveShared(data);
  res.json({ success: true, nickname });
});

// ==========================================
// TROLLBOX - Community Chat
// ==========================================
const TROLLBOX_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'trollbox.json');
const MAX_MESSAGES = 200; // Keep last 200 messages

function loadTrollbox() {
  try {
    if (fs.existsSync(TROLLBOX_FILE)) {
      return JSON.parse(fs.readFileSync(TROLLBOX_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load trollbox:', e.message);
  }
  return { messages: [] };
}

function saveTrollbox(data) {
  try {
    // Trim to last MAX_MESSAGES
    if (data.messages.length > MAX_MESSAGES) {
      data.messages = data.messages.slice(-MAX_MESSAGES);
    }
    fs.writeFileSync(TROLLBOX_FILE, JSON.stringify(data));
  } catch (e) {
    console.error('Failed to save trollbox:', e.message);
  }
}

// Get messages (optionally since a timestamp)
app.get('/api/trollbox', (req, res) => {
  const data = loadTrollbox();
  const since = req.query.since;
  if (since) {
    const filtered = data.messages.filter((m) => m.ts > since);
    return res.json({ messages: filtered });
  }
  // Return last 50 on initial load
  res.json({ messages: data.messages.slice(-50) });
});

// Post a message
app.post('/api/trollbox', (req, res) => {
  const { user_id, nickname, text } = req.body;
  if (!user_id || !text?.trim()) {
    return res.status(400).json({ error: 'user_id and text required' });
  }

  const data = loadTrollbox();
  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    user_id,
    nickname: nickname || 'Anonymous Pigeon',
    text: text.trim().slice(0, 500), // Max 500 chars
    ts: new Date().toISOString(),
  };
  data.messages.push(msg);
  saveTrollbox(data);
  res.json({ success: true, message: msg });
});

// Main chat endpoint — NO TIMEOUT LIMITS
app.post('/api/chat', async (req, res) => {
  const rawHarmonicKey = req.headers['x-harmonic-key'] || '';
  const rawAnthropicKey = req.headers['x-anthropic-key'] || '';
  const harmonicKey = (rawHarmonicKey && rawHarmonicKey !== '__SERVER__') ? rawHarmonicKey : process.env.HARMONIC_API_KEY;
  const anthropicKey = (rawAnthropicKey && rawAnthropicKey !== '__SERVER__') ? rawAnthropicKey : process.env.ANTHROPIC_API_KEY;

  if (!anthropicKey) {
    return res.json({ response: 'Error: No Anthropic API key. Go to Settings and reconnect.' });
  }

  const { message, companies, history } = req.body;
  let debugInfo = '';
  let companyData = '';
  let rawCompanies = []; // Keep raw data for frontend cards

  if (harmonicKey) {
    const authHeaders = { 'apikey': harmonicKey };
    const cleanQuery = extractSearchTerms(message);
    const msgLower = message.toLowerCase();
    console.log('Search query:', cleanQuery);

    try {
      // ====== AGENT CHAIN: Detect intent and make multiple API calls ======

      // Intent: "find companies similar to X" or "companies like X"
      const similarMatch = msgLower.match(/(?:similar to|companies like|startups like|comparable to|competitors of|competitor to)\s+([a-zA-Z0-9\s.&'-]+?)(?:\s+(?:in|for|that|who|which|with|from|doing|focused|building|within|around|across)|[,?!]|$)/);

      // Intent: people/founder search — "founders from X", "people who worked at X", "ex-X"
      const peopleMatch = msgLower.match(/(?:founders? (?:from|at|who)|people (?:from|at|who)|team from|ex[- ]?)([a-zA-Z0-9\s.&'-]+?)(?:\s+(?:building|in|who|that|crypto|web3|defi|fintech|startup|currently|now)|[,?!]|$)/);

      let extraData = '';

      console.log('[Agent] Similar match:', similarMatch ? similarMatch[1]?.trim() : 'none');
      console.log('[Agent] People match:', peopleMatch ? peopleMatch[1]?.trim() : 'none');

      if (similarMatch) {
        // ---- SIMILAR COMPANIES CHAIN ----
        const targetName = similarMatch[1].trim();
        console.log('[Agent] Similar companies chain for:', targetName);

        // Step 1: Find the target company
        const lookupUrl = `${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(targetName)}&size=1`;
        const lookupRes = await fetch(lookupUrl, { headers: authHeaders });
        if (lookupRes.ok) {
          const lookupData = await lookupRes.json();
          const results = lookupData.results || [];
          console.log('[Agent] Typeahead for "' + targetName + '" returned', results.length, 'results', results.length > 0 ? '→ ' + (results[0].name || 'unnamed') : '');
          const target = results[0];
          if (target) {
            const targetId = target.id || target.entity_urn?.split(':').pop();
            console.log('[Agent] Found target:', target.name, 'ID:', targetId);

            // Step 2: Get similar companies
            const simUrl = `${HARMONIC_BASE}/search/similar_companies/${targetId}?size=15`;
            const simRes = await fetch(simUrl, { headers: authHeaders });
            if (simRes.ok) {
              const simData = await simRes.json();
              const simCompanies = simData.results || simData.similar_companies || [];
              console.log('[Agent] Found', simCompanies.length, 'similar companies');

              // Step 3: Enrich top similar companies
              const simIds = simCompanies.map(c => c.id || c.entity_urn?.split(':').pop()).filter(Boolean).slice(0, 10);
              const enriched = [];
              for (const id of simIds) {
                try {
                  const r = await fetch(`${HARMONIC_BASE}/companies/${id}`, { headers: authHeaders });
                  if (r.ok) enriched.push(await r.json());
                } catch (e) {}
              }
              if (enriched.length > 0) {
                extraData += `\n\nSIMILAR COMPANIES TO "${target.name}" (${enriched.length} found):\n\n${enriched.map((c, i) => formatCompany(c, i + 1)).join('\n\n')}`;
                rawCompanies.push(...enriched);
                debugInfo += `Similar: ${enriched.length} companies like ${target.name}. `;
              }
            }

            // Also enrich the target itself
            try {
              const targetRes = await fetch(`${HARMONIC_BASE}/companies/${targetId}`, { headers: authHeaders });
              if (targetRes.ok) {
                const targetFull = await targetRes.json();
                extraData = `\n\nTARGET COMPANY:\n${formatCompany(targetFull, 0)}` + extraData;
                rawCompanies.unshift(targetFull);
              }
            } catch (e) {}
          }
        }
      }

      if (peopleMatch) {
        // ---- PEOPLE/FOUNDER SEARCH CHAIN (multi-query) ----
        const orgName = peopleMatch[1].trim();
        // Detect if user mentioned a sector context
        const sectorHint = msgLower.match(/(?:in|building|doing|focused on)\s+(crypto|web3|defi|fintech|ai|climate|saas|gaming|betting|consumer|health|bio)/)?.[1] || '';
        console.log('[Agent] People search chain for:', orgName, sectorHint ? '+ sector: ' + sectorHint : '');

        // Run multiple query variants in parallel for better coverage
        const queries = [
          `${orgName} founder CEO startup`,
          `ex ${orgName} co-founder`,
          `${orgName} ${sectorHint || 'crypto'} founder`,
          `former ${orgName} building startup`,
        ];

        const allPeople = [];
        const seenPeopleIds = new Set();

        const peopleResults = await Promise.allSettled(
          queries.map(q =>
            fetch(`${HARMONIC_BASE}/search/people?query=${encodeURIComponent(q)}&size=25`, { headers: authHeaders })
              .then(async r => r.ok ? (await r.json()) : { results: [] })
              .catch(() => ({ results: [] }))
          )
        );

        for (const result of peopleResults) {
          if (result.status === 'fulfilled') {
            for (const p of (result.value.results || [])) {
              const pid = p.id || p.person_id || p.entity_urn;
              if (pid && !seenPeopleIds.has(pid)) {
                seenPeopleIds.add(pid);
                allPeople.push(p);
              }
            }
          }
        }
        console.log('[Agent] Total unique people found:', allPeople.length);

        if (allPeople.length > 0) {
          // Enrich top people with full person details (get experience history)
          const enrichedPeople = [];
          const personIds = allPeople.slice(0, 30).map(p => p.id || p.person_id).filter(Boolean);
          
          const personBatchSize = 10;
          for (let i = 0; i < personIds.length; i += personBatchSize) {
            const batch = personIds.slice(i, i + personBatchSize);
            const batchResults = await Promise.allSettled(
              batch.map(pid =>
                fetch(`${HARMONIC_BASE}/people/${pid}`, { headers: authHeaders })
                  .then(async r => r.ok ? (await r.json()) : null)
                  .catch(() => null)
              )
            );
            for (const r of batchResults) {
              if (r.status === 'fulfilled' && r.value) enrichedPeople.push(r.value);
            }
            if (i + personBatchSize < personIds.length) await sleep(200);
          }

          console.log('[Agent] Enriched', enrichedPeople.length, 'people with full details');

          // Use enriched data if available, fall back to search results
          const peopleFinal = enrichedPeople.length > 0 ? enrichedPeople : allPeople;

          // Build detailed people summary
          const peopleSummary = peopleFinal.slice(0, 25).map((p, i) => {
            const name = p.name || p.full_name || '?';
            const title = p.title || p.current_title || '';
            const company = p.company_name || p.current_company || p.primary_company?.name || '';
            const linkedin = p.linkedin_url || p.socials?.linkedin?.url || '';
            const location = typeof p.location === 'object' 
              ? [p.location?.city, p.location?.country].filter(Boolean).join(', ')
              : (p.location || '');
            
            // Build experience string from positions
            const positions = p.experience || p.positions || p.work_history || [];
            const expStr = positions.slice(0, 4).map(e => {
              const co = e.company || e.company_name || e.organization || '';
              const t = e.title || e.role || '';
              const dates = e.start_date ? `(${String(e.start_date).slice(0, 7)}${e.end_date ? '–' + String(e.end_date).slice(0, 7) : '–present'})` : '';
              return `${t} @ ${co} ${dates}`.trim();
            }).filter(s => s.length > 5).join(' → ');

            return `${i + 1}. **${name}** — ${title}${company ? ' at ' + company : ''}${location ? ' (' + location + ')' : ''}${linkedin ? '\n   LinkedIn: ' + linkedin : ''}${expStr ? '\n   Career: ' + expStr : ''}`;
          }).join('\n\n');

          extraData += `\n\nPEOPLE SEARCH: "${orgName}" alumni who are founders/CEOs (${peopleFinal.length} found across ${queries.length} queries):\n\n${peopleSummary}`;
          debugInfo += `People: ${peopleFinal.length} from ${orgName}. `;

          // Extract unique current companies and enrich them
          const currentCompanies = new Map(); // name → person who works there
          for (const p of peopleFinal.slice(0, 20)) {
            const compName = p.company_name || p.current_company || p.primary_company?.name;
            const compId = p.primary_company?.id || p.company_id;
            if (compName && compName.toLowerCase() !== orgName.toLowerCase()) {
              if (!currentCompanies.has(compName)) {
                currentCompanies.set(compName, { name: compName, id: compId, founder: p.name || p.full_name || '?' });
              }
            }
          }

          if (currentCompanies.size > 0) {
            const companySummary = [...currentCompanies.entries()].slice(0, 15).map(([name, info]) => `${name} (${info.founder})`).join(', ');
            extraData += `\n\nCOMPANIES THESE PEOPLE ARE BUILDING: ${companySummary}`;

            // Enrich companies — try ID first, fall back to typeahead
            const toEnrich = [...currentCompanies.values()].slice(0, 10);
            for (const co of toEnrich) {
              try {
                let companyData = null;
                if (co.id) {
                  const cr = await fetch(`${HARMONIC_BASE}/companies/${co.id}`, { headers: authHeaders });
                  if (cr.ok) companyData = await cr.json();
                }
                if (!companyData) {
                  const sr = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(co.name)}&size=1`, { headers: authHeaders });
                  if (sr.ok) {
                    const sd = await sr.json();
                    const match = (sd.results || [])[0];
                    if (match) {
                      const cid = match.id || match.entity_urn?.split(':').pop();
                      const cr = await fetch(`${HARMONIC_BASE}/companies/${cid}`, { headers: authHeaders });
                      if (cr.ok) companyData = await cr.json();
                    }
                  }
                }
                if (companyData) {
                  rawCompanies.push(companyData);
                  extraData += `\n\nCOMPANY DETAIL (founded by ${orgName} alum ${co.founder}):\n${formatCompany(companyData, rawCompanies.length)}`;
                }
              } catch (e) {}
            }
            debugInfo += `Enriched ${Math.min(toEnrich.length, rawCompanies.length)} companies. `;
          }
        }
      }

      // ---- STANDARD COMPANY SEARCH (always runs) ----
      // If agent chain found a target company, search for the broader context instead
      let searchQuery = cleanQuery;
      if (similarMatch) {
        // For "similar to X in climate tech" → search "climate tech" broadly
        const afterCompany = msgLower.replace(similarMatch[0], '').replace(/^\s*(in|for|the|and|of)\s*/g, '').trim();
        if (afterCompany.length > 3) searchQuery = afterCompany;
        else searchQuery = similarMatch[1].trim(); // Fall back to the company name
      }
      if (searchQuery.length < 3) searchQuery = cleanQuery; // Safety fallback
      
      const searchUrl = `${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(searchQuery)}&size=50`;
      console.log('Harmonic URL:', searchUrl);

      const searchRes = await fetch(searchUrl, { headers: authHeaders });
      console.log('Search status:', searchRes.status);

      if (!searchRes.ok) {
        const errText = await searchRes.text().catch(() => '');
        debugInfo += `Search failed: ${searchRes.status}. `;
        console.error('Search error:', errText.slice(0, 300));
        companyData = `\n\n[Harmonic search failed: HTTP ${searchRes.status}]`;
      } else {
        const searchData = await searchRes.json();
        const urns = (searchData.results || [])
          .map((r) => r.urn)
          .filter(Boolean);

        console.log('URNs found:', urns.length, 'Total matches:', searchData.count);
        debugInfo += `URNs: ${urns.length}. Total: ${searchData.count}. `;

        if (searchData.query_interpretation) {
          console.log('Query interpretation:', JSON.stringify(searchData.query_interpretation));
        }

        if (urns.length === 0) {
          companyData = `\n\n[Harmonic found ${searchData.count || 0} matches but returned no URNs.]`;
        } else {
          // Step 2: Fetch full company details
          // Extract numeric ID from URN like "urn:harmonic:company:59742163"
          const companyIds = urns.map((urn) => {
            const parts = urn.split(':');
            return parts[parts.length - 1];
          });

          console.log('Fetching details for', companyIds.length, 'companies...');

          // Batch in groups of 10 to respect rate limit (10 req/sec)
          const fullCompanies = [];
          const batchSize = 10;

          for (let i = 0; i < companyIds.length; i += batchSize) {
            const batch = companyIds.slice(i, i + batchSize);
            const batchResults = await Promise.allSettled(
              batch.map((id) =>
                fetch(`${HARMONIC_BASE}/companies/${id}`, { headers: authHeaders })
                  .then(async (r) => {
                    if (!r.ok) return null;
                    return r.json();
                  })
                  .catch(() => null)
              )
            );

            for (const r of batchResults) {
              if (r.status === 'fulfilled' && r.value) {
                fullCompanies.push(r.value);
              }
            }

            // Small delay between batches for rate limiting
            if (i + batchSize < companyIds.length) {
              await sleep(200);
            }
          }

          console.log('Got details for', fullCompanies.length, '/', companyIds.length);
          debugInfo += `Details: ${fullCompanies.length}/${companyIds.length}. `;

          if (fullCompanies.length > 0) {
            const first = fullCompanies[0];
            console.log('First company:', first.name || first.company_name, '| keys:', Object.keys(first).slice(0, 15).join(', '));
            console.log('FUNDING KEYS:', first.funding ? Object.keys(first.funding).join(', ') : 'no funding obj');
            console.log('FUNDING FULL:', JSON.stringify(first.funding).slice(0, 1200));
            // Also dump a smaller company to see if they have different fields
            const small = fullCompanies.find(c => c.funding?.funding_total && c.funding.funding_total < 5000000);
            if (small) console.log('SMALL CO:', small.name, 'FUNDING:', JSON.stringify(small.funding).slice(0, 800));

            const sampleNames = fullCompanies.slice(0, 5).map((c) => s(c.name || c.company_name || '?')).join(', ');
            console.log('Sample:', sampleNames);
            debugInfo += `Sample: [${sampleNames}]. `;

            companyData = `\n\nCOMPANY DATA (${fullCompanies.length} companies from Harmonic, out of ${searchData.count} total matches):\n\n${fullCompanies
              .map((c, i) => formatCompany(c, i + 1))
              .join('\n\n')}`;

            console.log('Company data:', companyData.length, 'chars');
            rawCompanies.push(...fullCompanies); // Append (don't overwrite — agent chains may have added some)
          } else {
            if (!extraData) companyData = '\n\n[Harmonic returned URNs but all detail fetches failed.]';
          }
        }
      }

      // Append agent chain data
      if (extraData) {
        companyData += extraData;
        console.log('[Agent] Extra data appended:', extraData.length, 'chars');
      }
    } catch (e) {
      debugInfo += `Error: ${e.message}. `;
      console.error('Harmonic error:', e.message);
      companyData = `\n\n[Harmonic error: ${e.message}]`;
    }
  } else {
    companyData = '\n\n[No Harmonic API key configured.]';
  }

  console.log('Debug:', debugInfo);

  // Build lightweight card data for frontend rendering
  const companyCards = rawCompanies.map((c) => {
    const f = c.funding || {};
    
    // funding_total is a plain number at f.funding_total
    let fundingTotal = null;
    if (typeof f.funding_total === 'number') fundingTotal = f.funding_total;
    else if (typeof f.fundingTotal === 'number') fundingTotal = f.fundingTotal;
    else if (typeof f.funding_total === 'string') fundingTotal = parseFloat(f.funding_total) || null;
    else if (typeof f.fundingTotal === 'string') fundingTotal = parseFloat(f.fundingTotal) || null;

    // Try every possible stage field
    let fundingStage = null;
    const stageRaw = f.lastFundingType || f.last_funding_type || f.funding_stage || f.stage || f.last_round_type || null;
    if (stageRaw) {
      fundingStage = typeof stageRaw === 'string' ? stageRaw : (stageRaw?.name || stageRaw?.value || JSON.stringify(stageRaw));
    }

    // Try every possible date field
    let fundingDate = null;
    const dateRaw = f.last_funding_at || f.lastFundingDate || f.last_funding_date || f.last_round_date || null;
    if (dateRaw) {
      fundingDate = typeof dateRaw === 'string' ? dateRaw.slice(0, 10) : String(dateRaw).slice(0, 10);
    }

    // Last round amount
    let lastRoundAmount = null;
    if (typeof f.last_funding_total === 'number') lastRoundAmount = f.last_funding_total;

    // Extract location
    let location = null;
    if (c.location) {
      if (typeof c.location === 'string') location = c.location;
      else if (typeof c.location === 'object') {
        // Use the short "location" field if available, else build from parts
        if (c.location.location && typeof c.location.location === 'string') {
          // Clean up "169 Madison Ave #2199 New York, NY 10016, US" → just city/state
          const loc = c.location.location;
          // If it has a street address, use city/state instead
          if (c.location.city) {
            location = [c.location.city, c.location.state, c.location.country].filter(Boolean).join(', ');
          } else {
            location = loc;
          }
        } else {
          location = [c.location.city, c.location.state || c.location.region, c.location.country]
            .filter(Boolean)
            .join(', ');
        }
      }
    }

    // Extract funding rounds - try both camelCase and snake_case
    const roundsRaw = f.fundingRounds || f.funding_rounds || [];
    const fundingRounds = roundsRaw.map((r) => {
      let amt = null;
      const amtRaw = r.fundingAmount || r.funding_amount || r.amount;
      if (typeof amtRaw === 'number') amt = amtRaw;
      else if (typeof amtRaw === 'object' && amtRaw) amt = amtRaw.value || amtRaw.amount || null;
      return {
        type: r.fundingRoundType || r.funding_round_type || r.type || '',
        amount: amt,
        date: (r.announcedDate || r.announced_date || r.date || '').toString().slice(0, 10) || null,
        investors: (r.investors || []).map((i) => ({
          name: i.investorName || i.investor_name || i.name || '',
          lead: !!i.isLead || !!i.is_lead,
        })).filter((i) => i.name),
      };
    });

    // Also extract investors from top-level funding.investors
    const topInvestors = (f.investors || []).map((i) => i.name).filter(Boolean).slice(0, 5);

    return {
      name: c.name || c.legal_name || '?',
      description: (c.description || '').slice(0, 200),
      logo_url: c.logo_url || null,
      website: c.website?.url || c.website?.domain || (typeof c.website === 'string' ? c.website : null),
      founded: c.founding_date ? String(c.founding_date).slice(0, 4) : null,
      headcount: c.headcount || null,
      ownership_status: c.ownership_status || null,
      location,
      funding_total: fundingTotal,
      funding_stage: fundingStage,
      funding_date: fundingDate,
      last_round_amount: lastRoundAmount,
      funding_rounds: fundingRounds,
      investors: topInvestors,
      socials: {
        linkedin: c.socials?.linkedin?.url || (typeof c.socials?.linkedin === 'string' ? c.socials.linkedin : null),
        twitter: c.socials?.twitter?.url || (typeof c.socials?.twitter === 'string' ? c.socials.twitter : null),
      },
      tags: (c.tagsV2 || []).map((t) => t.displayValue || t.name || '').filter(Boolean).slice(0, 6),
      highlights: (c.highlights || []).map((h) => h.text || h).filter(Boolean).slice(0, 3),
    };
  });

  let focusContext = '';
  if (companies?.length) {
    focusContext = `\n\nFOCUS COMPANIES:\n${JSON.stringify(companies, null, 2)}`;
  }

  // Step 3: Claude analysis — also no timeout
  try {
    const msgs = [
      ...(history || []).slice(-6),
      { role: 'user', content: message },
    ];

    const fullSystem = SYSTEM_PROMPT + companyData + focusContext;
    console.log('System prompt:', fullSystem.length, 'chars');

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 4096,
        system: fullSystem,
        messages: msgs,
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text().catch(() => '');
      console.error('Claude error:', claudeRes.status, err.slice(0, 300));
      return res.json({ response: `Claude error (${claudeRes.status}). ${debugInfo}` });
    }

    const data = await claudeRes.json();
    const text = data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    return res.json({ response: text, companies: companyCards });
  } catch (err) {
    return res.json({ response: `Error: ${err.message}. ${debugInfo}` });
  }
});

// ==========================================
// HARMONIC ENRICHMENT ENDPOINTS
// ==========================================

// Domain lookup diagnostic
app.get('/api/harmonic/domain-lookup', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'No key' });
  const domain = req.query.domain || '';
  if (!domain) return res.json({ error: 'domain param required' });
  try {
    const url = `${HARMONIC_BASE}/companies?website_domain=${encodeURIComponent(domain)}`;
    const r = await fetch(url, { headers: { apikey: harmonicKey } });
    const data = r.ok ? await r.json() : { httpError: r.status };
    const isMatch = data && !Array.isArray(data) && data.id;
    res.json({
      domain,
      found: !!isMatch,
      harmonicId: data.id || null,
      harmonicName: data.name || null,
      harmonicWebsite: data.website?.url || data.website?.domain || null,
      rawType: Array.isArray(data) ? 'array' : typeof data,
      rawKeys: typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).slice(0, 10) : null,
    });
  } catch (e) {
    res.json({ domain, error: e.message });
  }
});

// Live typeahead search
app.get('/api/harmonic/typeahead', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ results: [] });
  const q = req.query.q || '';
  const size = parseInt(req.query.size) || 8;
  if (q.length < 2) return res.json({ results: [] });
  try {
    const url = `${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(q)}&size=${size}`;
    console.log(`[Typeahead] Fetching: ${url}`);
    const r = await fetch(url, { headers: { apikey: harmonicKey } });
    if (!r.ok) {
      console.error(`[Typeahead] HTTP ${r.status}`);
      return res.json({ results: [] });
    }
    const data = await r.json();
    console.log(`[Typeahead] Response type: ${typeof data}, isArray: ${Array.isArray(data)}, keys: ${typeof data === 'object' ? Object.keys(data).join(',') : 'n/a'}`);
    console.log(`[Typeahead] Raw: ${JSON.stringify(data).slice(0, 600)}`);

    let raw = Array.isArray(data) ? data : (data.results || []);
    console.log(`[Typeahead] "${q}" → ${raw.length} results`);

    // Extract unique numeric IDs
    const ids = [...new Set(raw.map(r => {
      const urn = r.entity_urn || r.entityUrn || r.urn || '';
      return parseInt(r.id || urn.split(':').pop()) || null;
    }).filter(Boolean))].slice(0, size);

    if (ids.length === 0) return res.json({ results: [] });
    console.log(`[Typeahead] IDs to enrich: ${ids.join(', ')}`);

    // Fast REST enrichment (skip GQL for speed)
    const enriched = [];
    const batchResults = await Promise.allSettled(
      ids.slice(0, 6).map(id =>
        fetch(`${HARMONIC_BASE}/companies/${id}`, { headers: { apikey: harmonicKey } })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value) {
        const c = r.value;
        enriched.push({
          id: c.id,
          name: c.name || c.legal_name || '?',
          domain: c.website?.domain || (typeof c.website === 'string' ? c.website : '') || '',
          logo_url: c.logo_url || c.logoUrl || '',
          entity_urn: c.entity_urn || `urn:harmonic:company:${c.id}`,
          description: (c.description || c.short_description || '').slice(0, 120),
          stage: c.stage || c.funding?.funding_stage || c.funding?.lastFundingType || '',
          headcount: c.headcount || null,
          website: c.website?.url || c.website?.domain || (typeof c.website === 'string' ? c.website : '') || '',
          funding_total: c.funding?.funding_total || c.funding?.fundingTotal || null,
          location: c.location ? (typeof c.location === 'string' ? c.location : [c.location.city, c.location.state, c.location.country].filter(Boolean).join(', ')) : '',
          twitter: c.socials?.twitter?.url || '',
          crunchbase: c.socials?.crunchbase?.url || '',
          socials: c.socials || {},
        });
      }
    }
    console.log(`[Typeahead] Enriched ${enriched.length}: ${enriched.map(e => e.name).join(', ')}`);
    res.json({ results: enriched });
  } catch (e) {
    console.error('[Typeahead] Error:', e.message);
    res.json({ results: [], error: e.message });
  }
});

// Find similar companies (with GQL enrichment)
app.get('/api/harmonic/similar/:id', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'No Harmonic API key', companies: [] });
  const size = parseInt(req.query.size) || 25;
  const companyId = req.params.id;
  console.log(`[Similar] Looking for companies similar to ID: ${companyId}`);
  try {
    let rawResults = [];
    const url1 = `${HARMONIC_BASE}/search/similar_companies/${companyId}?size=${size}`;
    console.log(`[Similar] Trying: ${url1}`);
    const r = await fetch(url1, { headers: { apikey: harmonicKey } });
    console.log(`[Similar] Response: ${r.status}`);
    if (r.ok) {
      const data = await r.json();
      console.log(`[Similar] Response shape: keys=${Object.keys(data).join(',')}, isArray=${Array.isArray(data)}`);
      if (Array.isArray(data)) rawResults = data;
      else rawResults = data.results || data.similar_companies || data.companies || [];
      console.log(`[Similar] Raw items: ${rawResults.length}, first type: ${rawResults[0] ? typeof rawResults[0] : 'empty'}`);
      if (rawResults[0]) console.log(`[Similar] First item keys: ${typeof rawResults[0] === 'object' ? Object.keys(rawResults[0]).slice(0, 8).join(',') : rawResults[0].toString().slice(0, 50)}`);
    } else {
      const errText = await r.text().catch(() => '');
      console.log(`[Similar] Primary failed: ${r.status} ${errText.slice(0, 100)}`);
      const url2 = `${HARMONIC_BASE}/search/similar_companies?company_id=${companyId}&size=${size}`;
      console.log(`[Similar] Trying alternate: ${url2}`);
      const r2 = await fetch(url2, { headers: { apikey: harmonicKey } });
      console.log(`[Similar] Alternate response: ${r2.status}`);
      if (r2.ok) {
        const data = await r2.json();
        if (Array.isArray(data)) rawResults = data;
        else rawResults = data.results || data.companies || [];
      }
    }
    console.log(`[Similar] Raw results: ${rawResults.length}`, rawResults.slice(0, 3).map(r => typeof r === 'string' ? r.slice(0, 40) : (r.id || r.entity_urn || JSON.stringify(r).slice(0, 40))));
    
    if (rawResults.length === 0) return res.json({ companies: [], message: 'No similar companies found' });

    const hideIdx = buildUserHideIndex(resolvePersonId(req));

    // Check if results are already full company objects (have name field)
    const alreadyFull = rawResults[0] && typeof rawResults[0] === 'object' && rawResults[0].name;
    if (alreadyFull) {
      console.log(`[Similar] Results already enriched, mapping ${rawResults.length} directly`);
      let companies = filterBackburn(rawResults.map(c => gqlToCard(c)));
      companies = filterUserHidden(companies, hideIdx);
      return res.json({ companies });
    }

    // Extract IDs from results (could be URNs, objects with just id, or plain IDs)
    const ids = rawResults.map(r => {
      if (typeof r === 'string') return r.includes(':') ? r.split(':').pop() : r;
      if (typeof r === 'number') return r;
      return r.id || (r.entity_urn || r.entityUrn || '').split(':').pop() || null;
    }).filter(Boolean);

    console.log(`[Similar] Extracted ${ids.length} IDs to enrich:`, ids.slice(0, 3));

    if (ids.length === 0) return res.json({ companies: [], message: 'No similar companies found' });

    // Pre-filter by Harmonic ID before paying for GQL enrichment (backburn + per-user hide)
    let idsAfterBurn = ids.filter(id => !_backburnIdx.ids.has(String(id)));
    if (hideIdx) idsAfterBurn = idsAfterBurn.filter(id => !hideIdx.ids.has(String(id)));
    if (idsAfterBurn.length < ids.length) console.log(`[Similar/Filter] Dropped ${ids.length - idsAfterBurn.length} IDs pre-enrich`);

    // Enrich via GraphQL
    const enriched = await gqlEnrichCompanies(idsAfterBurn, harmonicKey);
    let companies = filterBackburn(enriched.map(c => gqlToCard(c)));
    companies = filterUserHidden(companies, hideIdx);
    console.log(`[Similar] Enriched ${companies.length} companies`);
    res.json({ companies });
  } catch (e) {
    console.error(`[Similar] Error:`, e.message);
    res.json({ error: e.message, companies: [] });
  }
});

// Find similar by name (typeahead → similar → GQL enrich)
app.get('/api/harmonic/find-similar-by-name', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'No Harmonic API key', companies: [] });
  const name = req.query.name || '';
  const size = parseInt(req.query.size) || 25;
  if (!name) return res.json({ error: 'name required', companies: [] });

  try {
    // Step 1: Find company by name
    console.log(`[FindSimilar] Looking up "${name}"...`);
    const lookupRes = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(name)}&size=1`, { headers: { apikey: harmonicKey } });
    if (!lookupRes.ok) return res.json({ error: `Typeahead failed: ${lookupRes.status}`, companies: [] });
    const lookupData = await lookupRes.json();
    const results = lookupData.results || [];
    if (results.length === 0) return res.json({ error: `"${name}" not found in Harmonic`, companies: [] });

    const target = results[0];
    const targetId = target.id || (target.entity_urn || '').split(':').pop();
    console.log(`[FindSimilar] Found "${target.name}" (ID: ${targetId})`);

    // Step 2: Get similar companies
    let rawResults = [];
    const simUrl = `${HARMONIC_BASE}/search/similar_companies/${targetId}?size=${size}`;
    console.log(`[FindSimilar] Fetching similar: ${simUrl}`);
    const simRes = await fetch(simUrl, { headers: { apikey: harmonicKey } });
    console.log(`[FindSimilar] Similar response: ${simRes.status}`);
    if (simRes.ok) {
      const simData = await simRes.json();
      if (Array.isArray(simData)) rawResults = simData;
      else rawResults = simData.results || simData.similar_companies || simData.companies || [];
    } else {
      const errText = await simRes.text().catch(() => '');
      console.log(`[FindSimilar] Primary failed: ${errText.slice(0, 100)}`);
      const simRes2 = await fetch(`${HARMONIC_BASE}/search/similar_companies?company_id=${targetId}&size=${size}`, { headers: { apikey: harmonicKey } });
      if (simRes2.ok) {
        const simData2 = await simRes2.json();
        if (Array.isArray(simData2)) rawResults = simData2;
        else rawResults = simData2.results || simData2.companies || [];
      }
    }

    console.log(`[FindSimilar] Raw results: ${rawResults.length}`);
    if (rawResults.length === 0) return res.json({ error: 'No similar companies found', companies: [] });

    const hideIdx = buildUserHideIndex(resolvePersonId(req));

    // Check if already full objects
    const alreadyFull = rawResults[0] && typeof rawResults[0] === 'object' && rawResults[0].name;
    if (alreadyFull) {
      let companies = filterBackburn(rawResults.map(c => gqlToCard(c)));
      companies = filterUserHidden(companies, hideIdx);
      console.log(`[FindSimilar] Already enriched: ${companies.length}`);
      return res.json({ companies, targetName: target.name });
    }

    // Extract IDs and enrich
    const ids = rawResults.map(r => {
      if (typeof r === 'string') return r.includes(':') ? r.split(':').pop() : r;
      if (typeof r === 'number') return r;
      return r.id || (r.entity_urn || r.entityUrn || '').split(':').pop() || null;
    }).filter(Boolean);

    if (ids.length === 0) return res.json({ error: 'No similar companies found', companies: [] });

    // Pre-filter by Harmonic ID before GQL enrichment (backburn + per-user hide)
    let idsAfterBurn = ids.filter(id => !_backburnIdx.ids.has(String(id)));
    if (hideIdx) idsAfterBurn = idsAfterBurn.filter(id => !hideIdx.ids.has(String(id)));
    if (idsAfterBurn.length < ids.length) console.log(`[FindSimilar/Filter] Dropped ${ids.length - idsAfterBurn.length} IDs pre-enrich`);

    // Step 3: Enrich via GraphQL
    const enriched = await gqlEnrichCompanies(idsAfterBurn, harmonicKey);
    let companies = filterBackburn(enriched.map(c => gqlToCard(c)));
    companies = filterUserHidden(companies, hideIdx);
    console.log(`[FindSimilar] Enriched ${companies.length} similar to "${target.name}"`);
    res.json({ companies, targetName: target.name });
  } catch (e) {
    console.error('[FindSimilar] Error:', e.message);
    res.json({ error: e.message, companies: [] });
  }
});

// People search
app.get('/api/harmonic/people/search', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'No Harmonic API key', people: [] });
  const q = req.query.q || '';
  const size = parseInt(req.query.size) || 20;
  try {
    const r = await fetch(`${HARMONIC_BASE}/search/people?query=${encodeURIComponent(q)}&size=${size}`, { headers: { apikey: harmonicKey } });
    if (!r.ok) return res.json({ error: `Harmonic API error: ${r.status}`, people: [] });
    const data = await r.json();
    const people = (data.results || data.people || []).map(p => ({
      id: p.id || p.person_id,
      name: p.name || p.full_name || '?',
      title: p.title || p.current_title || '',
      company: p.company_name || p.current_company || '',
      linkedin: p.linkedin_url || p.socials?.linkedin || '',
      pfp: p.profile_image_url || p.avatar_url || '',
      experience: (p.experience || p.positions || []).slice(0, 5),
    }));
    res.json({ people, total: data.count || people.length });
  } catch (e) {
    res.json({ error: e.message, people: [] });
  }
});

// Company highlights/signals
app.get('/api/harmonic/company/:id/highlights', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'No Harmonic API key', highlights: [] });
  try {
    const r = await fetch(`${HARMONIC_BASE}/companies/${req.params.id}`, { headers: { apikey: harmonicKey } });
    if (!r.ok) return res.json({ error: `Harmonic API error: ${r.status}`, highlights: [] });
    const c = await r.json();
    const highlights = (c.highlights || []).map(h => h.text || h).filter(Boolean);
    const traction = c.tractionMetrics || {};
    res.json({
      highlights,
      traction: {
        webTraffic30d: traction.webTraffic?.ago30d?.percentChange || null,
        headcount90d: traction.headcount?.ago90d?.percentChange || null,
        engGrowth90d: traction.headcountEngineering?.ago90d?.percentChange || null,
      },
      headcount: c.headcount || null,
      foundedDate: c.founding_date || c.founded_year || null,
    });
  } catch (e) {
    res.json({ error: e.message, highlights: [] });
  }
});

// Company employees/founders
app.get('/api/harmonic/company/:id/team', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'No Harmonic API key', team: [] });
  const group = req.query.group || 'FOUNDERS_AND_CEO';
  try {
    const r = await fetch(`${HARMONIC_BASE}/companies/${req.params.id}/employees?employee_group_type=${group}`, { headers: { apikey: harmonicKey } });
    if (!r.ok) {
      // Fallback: get from company details
      const r2 = await fetch(`${HARMONIC_BASE}/companies/${req.params.id}`, { headers: { apikey: harmonicKey } });
      if (r2.ok) {
        const c = await r2.json();
        const team = (c.founders || c.people || []).map(p => ({
          name: p.name || p.full_name || '?',
          title: p.title || '',
          linkedin: p.linkedin_url || p.socials?.linkedin || '',
        }));
        return res.json({ team });
      }
      return res.json({ error: `Harmonic API error: ${r.status}`, team: [] });
    }
    const data = await r.json();
    const team = (data.results || data.employees || data || []).map(p => ({
      id: p.id || p.person_id,
      name: p.name || p.full_name || '?',
      title: p.title || p.current_title || '',
      linkedin: p.linkedin_url || p.socials?.linkedin || '',
      experience: (p.experience || p.positions || []).slice(0, 5),
    }));
    res.json({ team });
  } catch (e) {
    res.json({ error: e.message, team: [] });
  }
});

// ==========================================
// AUTO-SCAN ENDPOINT
// ==========================================
const SEEN_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'autoscan_seen.json');

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      // v2: only stores explicitly dismissed companies, not auto-scanned
      if (data._version === 2) return data;
      // Old format — wipe it
      console.log('[AutoScan] Clearing stale v1 seen data');
      const fresh = { _version: 2 };
      saveSeen(fresh);
      return fresh;
    }
  } catch (e) { console.error('loadSeen error:', e.message); }
  return { _version: 2 };
}

function saveSeen(data) {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify(data)); } catch (e) { console.error('saveSeen error:', e.message); }
}

// Reset seen companies for a person
app.get('/api/autoscan/seen-stats', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const allSeen = loadSeen();
  const stats = {};
  for (const [k, v] of Object.entries(allSeen)) {
    if (k === '_version') continue;
    stats[k] = Array.isArray(v) ? v.length : 0;
  }
  res.json({ stats, total: Object.values(stats).reduce((a, b) => a + b, 0) });
});

// Clear seen-set for a person (GET for easy browser access)
app.get('/api/autoscan/clear-seen/:personId', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const allSeen = loadSeen();
  const before = (allSeen[req.params.personId] || []).length;
  allSeen[req.params.personId] = [];
  saveSeen(allSeen);
  console.log(`[AutoScan] Cleared seen-set for ${req.params.personId} (was ${before} entries)`);
  res.json({ success: true, cleared: before, personId: req.params.personId });
});

app.delete('/api/autoscan/seen', (req, res) => {
  const { personId } = req.body;
  const allSeen = loadSeen();
  if (personId) {
    delete allSeen[personId];
  } else {
    // Clear all
    Object.keys(allSeen).forEach((k) => delete allSeen[k]);
  }
  saveSeen(allSeen);
  res.json({ success: true, message: personId ? `Cleared history for ${personId}` : 'Cleared all history' });
});

// Dismiss specific companies (mark as seen so they don't show up again)
app.post('/api/autoscan/dismiss', (req, res) => {
  const { personId, companyIds } = req.body;
  if (!personId || !companyIds?.length) {
    return res.status(400).json({ error: 'personId and companyIds required' });
  }
  const allSeen = loadSeen();
  const existing = new Set(allSeen[personId] || []);
  companyIds.forEach((id) => existing.add(String(id)));
  allSeen[personId] = [...existing].slice(-5000);
  saveSeen(allSeen);
  res.json({ success: true, dismissed: companyIds.length });
});

// ==========================================
// VETTING PIPELINE (shared across team)
// ==========================================
const VETTING_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'vetting_pipeline.json');

function loadVetting() {
  try {
    if (fs.existsSync(VETTING_FILE)) return JSON.parse(fs.readFileSync(VETTING_FILE, 'utf8'));
  } catch (e) { console.error('loadVetting error:', e.message); }
  return { companies: [] };
}

function saveVetting(data) {
  try { fs.writeFileSync(VETTING_FILE, JSON.stringify(data)); } catch (e) { console.error('saveVetting error:', e.message); }
}

// Get all vetting pipeline companies (active only)
app.get('/api/vetting', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const data = loadVetting();
  const showDismissed = req.query.dismissed === 'true';
  const active = showDismissed ? data.companies : data.companies.filter(c => !c.dismissed);
  // Sort: newest first
  active.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  res.json({ companies: active, total: active.length });
});

// Remove all stealth companies from vetting pipeline
app.post('/api/vetting/cleanup-stealth', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const data = loadVetting();
  const before = data.companies.length;
  const removed = data.companies.filter(c => (c.name || '').toLowerCase().startsWith('stealth company'));
  data.companies = data.companies.filter(c => !(c.name || '').toLowerCase().startsWith('stealth company'));
  saveVetting(data);
  console.log(`[Vetting] Stealth cleanup: removed ${removed.length} stealth companies from ${before} total`);
  res.json({ 
    success: true, 
    removed: removed.length, 
    remaining: data.companies.length,
    removedNames: removed.map(c => c.name)
  });
});

// Add companies to vetting pipeline
app.post('/api/vetting/add', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { companies, source } = req.body;
  if (!companies?.length) return res.status(400).json({ error: 'companies required' });
  
  const data = loadVetting();
  const existingNames = new Set(data.companies.map(c => (c.name || '').toLowerCase()));
  
  let added = 0;
  for (const c of companies) {
    const nameKey = (c.name || '').toLowerCase();
    if (existingNames.has(nameKey)) continue;
    existingNames.add(nameKey);
    data.companies.push({
      ...c,
      addedAt: Date.now(),
      source: source || 'scan',
      votes: {},        // { personId: 'in' | 'out' }
      dismissed: false,
    });
    added++;
  }
  
  saveVetting(data);
  console.log(`[Vetting] Added ${added} companies (${companies.length - added} dupes skipped)`);
  res.json({ success: true, added, total: data.companies.length });
});

// Vote on a company
const VOTING_PARTNERS = ['mark', 'joe', 'liam', 'carlo', 'jake'];

app.post('/api/vetting/vote', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { companyName, personId, vote } = req.body; // vote: 'in' | 'out'
  if (!companyName || !personId || !vote) return res.status(400).json({ error: 'companyName, personId, vote required' });
  
  const data = loadVetting();
  const company = data.companies.find(c => (c.name || '').toLowerCase() === companyName.toLowerCase());
  if (!company) return res.status(404).json({ error: 'Company not found' });
  
  company.votes = company.votes || {};
  company.votes[personId] = vote;
  
  // Check if all 5 partners voted Out → auto-dismiss
  const allOut = VOTING_PARTNERS.every(p => company.votes[p] === 'out');
  if (allOut) {
    company.dismissed = true;
    company.dismissedAt = Date.now();
    console.log(`[Vetting] All partners OUT on "${company.name}" — auto-dismissed`);
    // Also add to seen/dismissed for all scan profiles
    try {
      const seen = loadSeen();
      const companyId = company.id || company.name;
      VOTING_PARTNERS.forEach(p => {
        const existing = new Set(seen[p] || []);
        existing.add(String(companyId));
        seen[p] = [...existing].slice(-5000);
      });
      saveSeen(seen);
    } catch (e) {}
  }
  
  saveVetting(data);
  res.json({ success: true, votes: company.votes, dismissed: allOut });
});

// Remove a company from vetting (permanent dismiss)
app.post('/api/vetting/remove', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { companyName } = req.body;
  if (!companyName) return res.status(400).json({ error: 'companyName required' });
  
  const data = loadVetting();
  data.companies = data.companies.filter(c => (c.name || '').toLowerCase() !== companyName.toLowerCase());
  saveVetting(data);
  res.json({ success: true, remaining: data.companies.length });
});

// Backburn a company (mark as dismissed for ALL users, stays in data)
// Backburn a company — works whether or not it's already in the DD pipeline.
// Upserts to Airtable (CRM Stage = Backburn) so it's globally hidden across all search workflows.
// Body: { companyName, personId, harmonicId?, website?, description?, sector? }
app.post('/api/vetting/backburn', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
  const body = req.body || {};
  const { companyName, personId, harmonicId, website, description, sector } = body;
  if (!companyName) return res.status(400).json({ error: 'companyName required' });

  // 1. If in DD pipeline, remove. (Not an error if absent.)
  const data = loadVetting();
  const companyIdx = data.companies.findIndex(c => (c.name || '').toLowerCase() === companyName.toLowerCase());
  let removed = null;
  if (companyIdx !== -1) {
    removed = data.companies.splice(companyIdx, 1)[0];
    saveVetting(data);
  }

  // 2. Mark as seen for every partner so future per-user scans skip it
  try {
    const seenData = loadSeen();
    const companyId = String((removed && (removed.id || removed.name)) || harmonicId || companyName);
    const PARTNERS = ['mark', 'joe', 'liam', 'carlo', 'jake'];
    PARTNERS.forEach(p => {
      const existing = new Set(seenData[p] || []);
      existing.add(companyId);
      seenData[p] = [...existing].slice(-5000);
    });
    saveSeen(seenData);
  } catch (e) {}

  // 3. Persist to local backburn registry + warm in-memory index synchronously
  const payload = {
    name: (removed && removed.name) || companyName,
    harmonic_id: (removed && (removed.harmonic_id || removed.id)) || harmonicId || null,
    website: (removed && (removed.website || removed.url)) || website || '',
    source: 'vetting/backburn',
    backburnedBy: personId || null,
  };
  recordBackburn(payload);

  // 4. Upsert to Airtable as CRM Stage = "Backburn" (source-of-truth for partner-facing CRM)
  let airtableStatus = 'skipped';
  try {
    const hdrs = airtableHeaders();
    const baseId = process.env.AIRTABLE_BASE_ID;
    if (hdrs && baseId) {
      const formula = encodeURIComponent(`{Company} = "${companyName.replace(/"/g, '\\"')}"`);
      const findUrl = `${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${formula}&maxRecords=1`;
      const findRes = await fetch(findUrl, { headers: hdrs });
      const findData = findRes.ok ? await findRes.json() : { records: [] };
      const existing = (findData.records || [])[0];
      if (existing) {
        // PATCH stage
        const patchRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${existing.id}`, {
          method: 'PATCH', headers: hdrs,
          body: JSON.stringify({ fields: { 'CRM Stage': 'Backburn' } }),
        });
        airtableStatus = patchRes.ok ? 'patched' : `patch_failed_${patchRes.status}`;
      } else {
        // Create as Backburn
        const fields = {
          'Company': companyName,
          'CRM Stage': 'Backburn',
          'Source': 'Pigeon Finder',
        };
        if (website) fields['Company Link'] = website;
        if (sector) fields['Sector'] = sector;
        if (description) fields['Original Notes + Ongoing Negotiation Notes'] = (description || '').slice(0, 500);
        if (harmonicId) fields['Harmonic ID'] = String(harmonicId);
        const createRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}`, {
          method: 'POST', headers: hdrs,
          body: JSON.stringify({ fields }),
        });
        airtableStatus = createRes.ok ? 'created' : `create_failed_${createRes.status}`;
      }
    }
  } catch (e) {
    console.error('[Vetting/backburn] Airtable upsert error:', e.message);
    airtableStatus = `error: ${e.message}`;
  }

  console.log(`[Vetting] "${companyName}" backburned (removed_from_dd: ${!!removed}, airtable: ${airtableStatus}) by ${personId || 'unknown'}`);
  res.json({ success: true, removed: !!removed, airtable: airtableStatus });
  } catch (e) {
    console.error('[Vetting/backburn] Unhandled error:', e.message, e.stack?.slice(0, 500));
    if (!res.headersSent) res.status(500).json({ error: e.message || 'backburn failed' });
  }
});

// Hide a company from a specific user's FUTURE SEARCH RESULTS only.
// Distinct from `/api/vetting/hide` (DD-pipeline-scoped) — this works for any company.
// Body: { companyName, personId, harmonicId?, website? }
app.post('/api/hide-for-user', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { companyName, personId, harmonicId, website } = req.body;
  if (!companyName || !personId) return res.status(400).json({ error: 'companyName and personId required' });
  const all = loadUserHidden();
  const key = personId.toLowerCase();
  if (!all[key]) all[key] = [];
  // Dedupe by normalized name + harmonic_id
  const nameKey = normalizeBackburnName(companyName);
  const exists = all[key].find(e => normalizeBackburnName(e.name) === nameKey);
  if (!exists) {
    all[key].push({
      name: companyName,
      harmonic_id: harmonicId || null,
      website: website || '',
      hiddenAt: Date.now(),
    });
    // Cap per-user list at 5000 to bound memory
    if (all[key].length > 5000) all[key] = all[key].slice(-5000);
    saveUserHidden(all);
  }
  console.log(`[HideForUser] ${personId}: "${companyName}" (total: ${all[key].length})`);
  res.json({ success: true, total: all[key].length });
});

app.post('/api/unhide-for-user', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { companyName, personId } = req.body;
  if (!companyName || !personId) return res.status(400).json({ error: 'companyName and personId required' });
  const all = loadUserHidden();
  const key = personId.toLowerCase();
  if (all[key]) {
    const nameKey = normalizeBackburnName(companyName);
    all[key] = all[key].filter(e => normalizeBackburnName(e.name) !== nameKey);
    saveUserHidden(all);
  }
  res.json({ success: true });
});

app.get('/api/hide-for-user', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const personId = (req.query.personId || '').toString().toLowerCase();
  if (!personId) return res.status(400).json({ error: 'personId required' });
  const all = loadUserHidden();
  res.json({ companies: all[personId] || [], total: (all[personId] || []).length });
});

// Hide a company for a specific user only (doesn't affect others)
app.post('/api/vetting/hide', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { companyName, personId } = req.body;
  if (!companyName || !personId) return res.status(400).json({ error: 'companyName and personId required' });

  const data = loadVetting();
  const company = data.companies.find(c => (c.name || '').toLowerCase() === companyName.toLowerCase());
  if (!company) return res.status(404).json({ error: 'Company not found' });

  if (!company.hiddenBy) company.hiddenBy = [];
  if (!company.hiddenBy.includes(personId)) company.hiddenBy.push(personId);
  saveVetting(data);
  console.log(`[Vetting] "${companyName}" hidden for ${personId}`);
  res.json({ success: true });
});

// Get backburned companies
app.get('/api/vetting/backburned', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const data = loadVetting();
  const backburned = data.companies.filter(c => c.backburned || c.dismissed);
  backburned.sort((a, b) => (b.backburnedAt || b.addedAt || 0) - (a.backburnedAt || a.addedAt || 0));
  res.json({ companies: backburned, total: backburned.length });
});

// ==========================================
// BATCH MANAGEMENT (saved search → DD pipeline)
// ==========================================
const BATCH_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'scan_batches.json');

function loadBatches() {
  try {
    if (fs.existsSync(BATCH_FILE)) return JSON.parse(fs.readFileSync(BATCH_FILE, 'utf8'));
  } catch (e) { console.error('loadBatches error:', e.message); }
  return {};
}

function saveBatches(data) {
  try { fs.writeFileSync(BATCH_FILE, JSON.stringify(data)); } catch (e) { console.error('saveBatches error:', e.message); }
}

// Get batch status for a person
app.get('/api/autoscan/batches/:personId', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const batches = loadBatches();
  const personBatch = batches[req.params.personId] || {};
  res.json({
    batch1Count: (personBatch.batch1 || []).length,
    batch2Count: (personBatch.batch2 || []).length,
    lastScanDate: personBatch.lastScanDate || null,
    lastBatchPush: personBatch.lastBatchPush || null,
  });
});

// Promote batch2 → DD pipeline
app.post('/api/autoscan/promote-batch', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { personId } = req.body;
  if (!personId) return res.status(400).json({ error: 'personId required' });

  const batches = loadBatches();
  const personBatch = batches[personId];

  if (!personBatch?.batch2?.length) {
    return res.json({ success: false, message: 'No batch2 to promote', promoted: 0 });
  }

  // Push batch2 to vetting pipeline
  const vetting = loadVetting();
  const existingNames = new Set(vetting.companies.map(c => (c.name || '').toLowerCase()));
  let added = 0;

  for (const c of personBatch.batch2) {
    if (!existingNames.has((c.name || '').toLowerCase())) {
      existingNames.add((c.name || '').toLowerCase());
      vetting.companies.push({
        ...c,
        addedAt: Date.now(),
        source: `batch2-promoted:${personId}`,
        votes: {},
        dismissed: false,
      });
      added++;
    }
  }

  saveVetting(vetting);
  personBatch.batch1 = personBatch.batch2;
  personBatch.batch2 = [];
  personBatch.lastBatchPush = Date.now();
  saveBatches(batches);

  console.log(`[Batch] Promoted ${added} companies from batch2 for ${personId}`);
  res.json({ success: true, promoted: added });
});

// ==========================================
// SAVED SEARCH SCAN FUNCTION
// ==========================================

function extractCompaniesFromSavedSearch(data) {
  // Harmonic returns results in various shapes
  if (Array.isArray(data)) return data;
  if (data.results && Array.isArray(data.results)) return data.results;
  if (data.companies && Array.isArray(data.companies)) return data.companies;
  return [];
}

async function savedSearchScan(savedSearchIds, authHeaders, seenSet) {
  const allCompanies = [];

  for (const search of savedSearchIds) {
    try {
      let companies = [];
      
      // Fetch ALL results — request large batch to minimize pagination issues
      // Harmonic's cursor pagination can return overlapping results, so we request
      // up to 1000 at once and dedup in-loop
      let afterCursor = null;
      let page = 0;
      const PAGE_SIZE = 500; // Request large pages to reduce cursor issues
      let totalExpected = null;
      const seenInThisFetch = new Set(); // detect when Harmonic starts recycling
      
      do {
        let url = `${HARMONIC_BASE}/savedSearches:results/${search.id}?size=${PAGE_SIZE}`;
        if (afterCursor) url += `&cursor=${encodeURIComponent(afterCursor)}`;
        
        // Retry up to 3 times with increasing timeout
        let res = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 300000); // 5min timeout
            res = await fetch(url, { headers: authHeaders, signal: controller.signal });
            clearTimeout(timeout);
            if (res.ok) break;
            console.error(`[SavedSearchScan] "${search.name}" page ${page + 1} attempt ${attempt} failed: ${res.status}`);
            res = null;
          } catch (fetchErr) {
            console.error(`[SavedSearchScan] "${search.name}" page ${page + 1} attempt ${attempt} error: ${fetchErr.message}`);
            res = null;
          }
          if (attempt < 3) await sleep(2000 * attempt); // 2s, 4s backoff
        }
        if (!res || !res.ok) {
          console.error(`[SavedSearchScan] "${search.name}" page ${page + 1} failed after 3 retries`);
          break;
        }
        const data = await res.json();
        const batch = extractCompaniesFromSavedSearch(data);
        
        // Dedup within this fetch — detect recycling
        let newInBatch = 0;
        for (const c of batch) {
          const cid = String(c.id || c.entity_id || (c.entity_urn || '').split(':').pop());
          if (cid && !seenInThisFetch.has(cid)) {
            seenInThisFetch.add(cid);
            companies.push(c);
            newInBatch++;
          }
        }
        page++;
        
        // Get total count and page_info from response
        if (totalExpected === null) {
          totalExpected = data.count || data.total || data.totalCount || null;
          console.log(`[SavedSearchScan] "${search.name}" response keys: ${Object.keys(data).join(', ')} | total: ${totalExpected || 'unknown'} | page_info: ${JSON.stringify(data.page_info || data.pageInfo || 'none').slice(0, 200)}`);
        }
        
        // Extract cursor from page_info — Harmonic uses {next, has_next, current}
        const pi = data.page_info || data.pageInfo || {};
        const hasNext = pi.has_next || pi.has_next_page || pi.hasNextPage || false;
        const nextCursor = pi.next || pi.end_cursor || pi.endCursor || null;
        
        console.log(`[SavedSearchScan] "${search.name}" page ${page}: ${newInBatch} new / ${batch.length} fetched (${companies.length}/${totalExpected || '?'} unique) hasNext=${hasNext}`);
        
        // Stop conditions
        if (batch.length === 0) break;
        if (newInBatch === 0) { console.log(`[SavedSearchScan] "${search.name}" — all duplicates, stopping`); break; }
        if (!hasNext) break;
        if (!nextCursor) break;
        if (totalExpected && companies.length >= totalExpected) break;
        
        afterCursor = nextCursor;
        await sleep(150);
      } while (page < 30); // Safety cap: 30 pages = 3000 companies max

      // Tag each company with source category
      companies.forEach(c => {
        c._sourceCategory = search.category || search.name;
        c._sourceSearchId = search.id;
        c._sourceSearchName = search.name;
      });

      allCompanies.push(...companies);
      console.log(`[SavedSearchScan] "${search.name}" → ${companies.length} total companies`);
      await sleep(200);
    } catch (e) {
      console.error(`[SavedSearchScan] Error on "${search.name}":`, e.message);
    }
  }

  // Deduplicate by ID
  const seen = new Set();
  const unique = allCompanies.filter(c => {
    const id = c.id || c.entity_id || c.entity_urn;
    if (!id || seen.has(String(id))) return false;
    seen.add(String(id));
    return true;
  });

  // Filter out previously dismissed
  const fresh = unique.filter(c => {
    const id = String(c.id || c.entity_id || (c.entity_urn || '').split(':').pop());
    return !seenSet.has(id);
  });

  console.log(`[SavedSearchScan] Total: ${allCompanies.length}, Deduped: ${unique.length}, Fresh: ${fresh.length}`);
  return { companies: fresh, totalBeforeDedup: allCompanies.length, totalAfterDedup: unique.length };
}

// ==========================================
// CRM DEDUP — skip companies already in pipeline
// ==========================================

async function fetchCrmCompanyNames() {
  try {
    const headers = airtableHeaders();
    const baseId = process.env.AIRTABLE_BASE_ID;
    if (!headers || !baseId) return new Map();

    const stages = ['BO', 'BORO', 'BORO-SM', 'Warm'];
    const nameToStage = new Map(); // name → stage

    for (const stage of stages) {
      try {
        const formula = encodeURIComponent(`{CRM Stage} = "${stage}"`);
        const url = `${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${formula}&maxRecords=500&fields%5B%5D=Company`;
        const r = await fetch(url, { headers });
        if (r.ok) {
          const data = await r.json();
          for (const rec of (data.records || [])) {
            const name = (rec.fields['Company'] || '').trim().toLowerCase();
            if (name) nameToStage.set(name, stage);
          }
        }
      } catch (e) {
        console.error(`[CRM Dedup] Error fetching ${stage}:`, e.message);
      }
    }

    console.log(`[CRM Dedup] Loaded ${nameToStage.size} company names from CRM (BO/BORO/BORO-SM/Warm)`);
    return nameToStage;
  } catch (e) {
    console.error('[CRM Dedup] Error:', e.message);
    return new Map();
  }
}

// Portfolio companies — always excluded from search results
const PORTCO_DOMAINS = new Set([
  'steel.dev', 'bubblemaps.io', 'pump.fun', 'xverse.app', 'trendex.vip',
  'haloo.ai', 'hirechain.io', 'botanixlabs.xyz', 'pear.garden', 'lagoon.finance',
  'aura.fun', 'ord.io', 'kinddesigns.com', 'raze.finance', 'bound.money',
  'worm.wtf', 'cobfoods.com', 'vest.markets', 'thetaneurotech.com',
]);
const PORTCO_NAMES = new Set([
  'steel.dev', 'bubblemaps', 'pump.fun', 'xverse', 'trendex', 'haloo',
  'hirechain', 'botanix labs', 'pear protocol', 'lagoon finance', 'aura fun',
  'ord.io', 'kind designs', 'raze', 'bound money', 'worm.wtf', 'cob',
  'vest markets', 'theta neurotech',
]);

function isPortco(company) {
  const name = (company.name || '').toLowerCase().trim();
  const domain = (company.website?.domain || company.domain || '').toLowerCase().replace(/^www\./, '');
  return PORTCO_NAMES.has(name) || PORTCO_DOMAINS.has(domain) ||
    [...PORTCO_NAMES].some(p => name.includes(p) || p.includes(name));
}

// Cache portfolio context — refresh every 6 hours
let _portfolioCache = { text: '', fetchedAt: 0 };
const PORTFOLIO_CACHE_TTL = 6 * 60 * 60 * 1000;

// Stage-based affinity boost percentages
const STAGE_BOOST = {
  'BO': 10,
  'BORO': 20,
  'BORO-SM': 35,
  'Warm': 27.5,
};

async function fetchPortfolioContext() {
  if (_portfolioCache.text && (Date.now() - _portfolioCache.fetchedAt) < PORTFOLIO_CACHE_TTL) {
    console.log(`[Portfolio] Using cached context (${_portfolioCache.text.length} chars)`);
    return _portfolioCache.text;
  }
  
  try {
    const headers = airtableHeaders();
    const baseId = process.env.AIRTABLE_BASE_ID;
    if (!headers || !baseId) {
      console.log('[Portfolio] Airtable not configured');
      return '';
    }

    const investedStages = ['BO', 'BORO', 'BORO-SM', 'Warm'];
    const portcos = [];

    for (const stage of investedStages) {
      try {
        const formula = encodeURIComponent(`{CRM Stage} = "${stage}"`);
        const url = `${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${formula}&maxRecords=200&fields%5B%5D=Company&fields%5B%5D=Sector&fields%5B%5D=CRM+Stage&fields%5B%5D=Original+Notes+%2B+Ongoing+Negotiation+Notes&fields%5B%5D=Total+Funding&fields%5B%5D=Company+Link`;
        console.log(`[Portfolio] Fetching ${stage}...`);
        const r = await fetch(url, { headers });
        if (r.ok) {
          const data = await r.json();
          const count = (data.records || []).length;
          console.log(`[Portfolio] ${stage}: ${count} records`);
          for (const rec of (data.records || [])) {
            const name = (rec.fields['Company'] || '').trim();
            if (!name) continue;
            portcos.push({
              name,
              sector: rec.fields['Sector'] || '',
              stage: stage,
              boost: STAGE_BOOST[stage] || 0,
              notes: (rec.fields['Original Notes + Ongoing Negotiation Notes'] || '').slice(0, 150),
              website: rec.fields['Company Link'] || '',
            });
          }
        } else {
          const err = await r.text().catch(() => '');
          console.error(`[Portfolio] ${stage} fetch failed: ${r.status} ${err.slice(0, 200)}`);
        }
      } catch (e) {
        console.error(`[Portfolio] ${stage} error:`, e.message);
      }
    }

    console.log(`[Portfolio] Total portcos found: ${portcos.length}`);
    if (portcos.length === 0) return '';

    const byStage = {};
    for (const p of portcos) {
      if (!byStage[p.stage]) byStage[p.stage] = [];
      byStage[p.stage].push(p);
    }

    const stageLines = Object.entries(byStage).map(([stage, companies]) => {
      const boost = STAGE_BOOST[stage] || 0;
      return `\n${stage} (${companies.length} companies — +${boost}% affinity boost):\n  ${companies.map(p => `${p.name}${p.sector ? ` [${p.sector}]` : ''}${p.notes ? ` — ${p.notes.slice(0, 80)}` : ''}`).join('\n  ')}`;
    }).join('');

    const text = `DAXOS CAPITAL CRM & PORTFOLIO CONTEXT (${portcos.length} companies):

FUND PROFILE: Daxos Capital writes $100K-$250K checks at Pre-Seed and Seed. Every company in this CRM was sourced, evaluated, and entered the pipeline at Pre-Seed or Seed stage, typically at $6M-$30M valuation (most around $10M). This means the companies below represent Daxos's proven investment thesis — the sectors, business models, and founder profiles that the fund actively bets on. New companies that resemble these patterns (same stage, similar valuation range, adjacent market) are HIGH-SIGNAL matches.
${stageLines}

AFFINITY SCORING RULES — Apply these boosts when a NEW company is adjacent to, complementary with, or shares infrastructure/market with CRM companies:
- Affinity with a BO company → +10% score boost (e.g. raw 6 → 6.6 → round to 7)
- Affinity with a BORO company → +20% score boost (e.g. raw 6 → 7.2 → round to 7)
- Affinity with a BORO-SM company → +35% score boost (e.g. raw 6 → 8.1 → round to 8)
- Affinity with a Warm company → +27.5% score boost (e.g. raw 6 → 7.65 → round to 8)
- General portfolio adjacency (no specific match) → +25% score boost

When multiple affinities apply, use the HIGHEST single boost (don't stack).
Always flag the affinity: "Portfolio affinity: [CompanyName] ([Stage]) — [reason]"

WEB TRACTION RULES — Apply these based on 30-day web traffic growth (shown as "Web 30d" in company data):

GROWTH BOOSTS (positive web growth — calculated as X/3 for 1-100%, then tiered above):
- Web 30d +1% to +100% → boost = growth% / 3 (e.g. +60% growth → +20% boost, +90% → +30%)
- Web 30d +101% to +150% → +40% score boost (flag "🚀🚀 Strong growth: +X%")
- Web 30d +151% to +225% → +55% score boost (flag "🚀🚀🚀 Explosive growth: +X%")
- Web 30d +226% to +375% → +70% score boost (flag "🔥🚀 Viral growth: +X%")
- Web 30d +376% or higher → +80% score boost (flag "🔥🔥 Hypergrowth: +X%")

DECLINE PENALTIES (negative web growth):
- Web 30d -1% to -25% → -10% score penalty (flag "📉 Slight decline: X%")
- Web 30d -26% to -50% → -20% score penalty (flag "📉📉 Declining: X%")
- Web 30d -51% or worse → -30% score penalty (flag "📉📉📉 Sharp decline: X%")
- IMPORTANT: Reduce or ignore decline penalty if the company has PORTFOLIO AFFINITY (matches a BO/BORO/BORO-SM/Warm company). Portfolio signal outweighs short-term traffic dips.

Between 0% and +1% → no adjustment.
These stack with portfolio affinity boosts. Apply web growth boost/penalty AFTER affinity boost.

HARD EXCLUSION (never PASS regardless of growth): ecological/climate startups, donation/charitable ventures, carbon credit platforms. Also ALWAYS CUT: VC firms, investment funds, hedge funds, private equity firms, asset managers, family offices, fund-of-funds, and any entity that is itself an investment vehicle rather than an operating startup. If a company has a "portfolio" page listing investments or describes itself as investing in other companies, it is NOT a startup — CUT it. CUT these even if they have 500% web growth.`;

    console.log(`[Portfolio] Built context: ${portcos.length} companies across ${Object.keys(byStage).length} stages (${text.length} chars)`);
    _portfolioCache = { text, fetchedAt: Date.now() };
    return text;
  } catch (e) {
    console.error('[Portfolio] Error building context:', e.message);
    return '';
  }
}


// Debug: test portfolio context
app.get('/api/debug/portfolio', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  _portfolioCache = { text: '', fetchedAt: 0 };
  const text = await fetchPortfolioContext();
  res.json({ length: text.length, text: text || '(empty)' });
});

// ==========================================
// SCAN PROFILES — server-side storage (syncs across devices)
// ==========================================
const PROFILES_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'scan_profiles.json');

function loadServerProfiles() {
  try {
    if (fs.existsSync(PROFILES_FILE)) return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  } catch (e) { console.error('[Profiles] Load error:', e.message); }
  return {};
}

function saveServerProfiles(data) {
  try { fs.writeFileSync(PROFILES_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error('[Profiles] Save error:', e.message); }
}

app.get('/api/profiles/:personId?', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const all = loadServerProfiles();
  if (req.params.personId) {
    res.json({ profiles: all[req.params.personId] || [] });
  } else {
    res.json({ profiles: all });
  }
});

app.post('/api/profiles/:personId', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { profiles } = req.body;
  if (!Array.isArray(profiles)) return res.status(400).json({ error: 'profiles array required' });
  const all = loadServerProfiles();
  all[req.params.personId] = profiles;
  saveServerProfiles(all);
  console.log(`[Profiles] Saved ${profiles.length} profiles for ${req.params.personId}`);
  res.json({ success: true, count: profiles.length });
});

app.post('/api/profiles', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { profiles } = req.body;
  if (!profiles || typeof profiles !== 'object') return res.status(400).json({ error: 'profiles object required' });
  saveServerProfiles(profiles);
  console.log(`[Profiles] Bulk saved profiles for ${Object.keys(profiles).length} people`);
  res.json({ success: true, people: Object.keys(profiles).length });
});


function profileToQueries(profile, mode = 'daily') {
  const sectors = profile.sectors || [];
  const stages = (profile.stages || []).filter(s => s !== 'Any');
  const keywords = (profile.keywords || '').split(',').map(k => k.trim()).filter(Boolean);
  const stageStr = stages.length > 0 ? stages[0].toLowerCase() : '';
  const maxQueries = mode === 'weekly' ? 6 : 4;

  const queries = [];

  // Strategy 1: Keywords — most specific. Rotate through them.
  // For daily, pick different keywords than yesterday (rotate by day-of-year)
  if (keywords.length > 0) {
    const dayIdx = Math.floor(Date.now() / 86400000) % Math.max(keywords.length, 1);
    const rotated = [...keywords.slice(dayIdx), ...keywords.slice(0, dayIdx)];
    for (const kw of rotated.slice(0, Math.min(3, maxQueries))) {
      let q = kw;
      if (stageStr && kw.length < 30) q += ` ${stageStr} startups`;
      queries.push(q.trim());
    }
  }

  // Strategy 2: Sectors — rotate through them daily
  if (sectors.length > 0 && queries.length < maxQueries) {
    const dayIdx = Math.floor(Date.now() / 86400000) % Math.max(sectors.length, 1);
    const rotated = [...sectors.slice(dayIdx), ...sectors.slice(0, dayIdx)];
    for (const s of rotated.slice(0, maxQueries - queries.length)) {
      let q = s.replace(/\//g, ' ').replace(/\s+/g, ' ').trim();
      if (stageStr) q += ` ${stageStr}`;
      q += ' startups';
      queries.push(q);
    }
  }

  // Strategy 3: Broader combo queries for better coverage
  if (keywords.length > 0 && sectors.length > 0 && queries.length < maxQueries) {
    // Combine a keyword with a sector for cross-pollination
    const kw = keywords[Math.floor(Date.now() / 86400000) % keywords.length];
    const sec = sectors[Math.floor(Date.now() / 86400000) % sectors.length].replace(/\//g, ' ');
    queries.push(`${kw} ${sec}`.trim());
  }

  // Strategy 4: Notes-based query
  if (profile.notes && profile.notes.length > 10 && queries.length < maxQueries) {
    const note = profile.notes.split(/[.!?\n]/)[0].trim().slice(0, 80);
    if (note.length > 10) queries.push(note);
  }

  // Deduplicate
  const seen = new Set();
  const unique = [];
  for (const q of queries) {
    const key = q.toLowerCase().trim();
    if (!seen.has(key) && key.length > 3) { seen.add(key); unique.push(q); }
  }

  console.log(`[Queries] Generated ${unique.length} for mode=${mode}:`, unique.map(q => q.slice(0, 50)));
  return unique.slice(0, maxQueries);
}

// Check scan status (is a scan running? what were the last results?)
app.get('/api/autoscan/status/:personId?', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Auto-clear stale "scanning" statuses older than 15 min
  const now = Date.now();
  for (const [pid, s] of Object.entries(global._scanStatus || {})) {
    if (s.status === 'scanning' && s.startedAt && (now - s.startedAt) > 15 * 60 * 1000) {
      console.log(`[AutoScan] Clearing stale scanning status for ${pid} (started ${Math.round((now - s.startedAt)/60000)}min ago)`);
      // Check if results exist on disk before clearing — scan may have finished but status wasn't updated
      try {
        const resultsFile = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'last_scan_results.json');
        const allResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
        if (allResults[pid] && allResults[pid].timestamp > s.startedAt) {
          console.log(`[AutoScan] Found results on disk for ${pid}, marking as done instead of idle`);
          global._scanStatus[pid] = { status: 'done', finishedAt: allResults[pid].timestamp, profileName: allResults[pid].profileName || 'Scan' };
          continue;
        }
      } catch (e) { /* no results file */ }
      global._scanStatus[pid] = { status: 'idle' };
    }
  }
  if (req.params.personId) {
    const status = (global._scanStatus || {})[req.params.personId] || { status: 'idle' };
    res.json(status);
  } else {
    res.json(global._scanStatus || {});
  }
});

// Get last scan results for a person (survives tab close)
app.get('/api/autoscan/last-results/:personId', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const resultsFile = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'last_scan_results.json');
    const allResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    const result = allResults[req.params.personId];
    if (result) {
      res.json(result);
    } else {
      res.json({ error: 'No results found' });
    }
  } catch (e) {
    res.json({ error: 'No results file' });
  }
});

// Scan history — server-side, persists across browser clears
const SCAN_HISTORY_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'scan_history.json');

function loadScanHistory() {
  try { if (fs.existsSync(SCAN_HISTORY_FILE)) return JSON.parse(fs.readFileSync(SCAN_HISTORY_FILE, 'utf8')); } catch(e) {}
  return [];
}
function saveScanHistory(history) {
  try { fs.writeFileSync(SCAN_HISTORY_FILE, JSON.stringify(history.slice(0, 100))); } catch(e) {} // Keep last 100
}

app.get('/api/autoscan/history', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const autoHistory = loadScanHistory();
  const recurringHistory = loadRecurringScanHistory();
  const merged = [...autoHistory, ...recurringHistory].sort((a, b) => {
    const ta = typeof a.timestamp === 'string' ? new Date(a.timestamp).getTime() : (a.timestamp || 0);
    const tb = typeof b.timestamp === 'string' ? new Date(b.timestamp).getTime() : (b.timestamp || 0);
    return tb - ta;
  });
  res.json({ history: merged });
});

app.post('/api/autoscan/history/add', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { personId, profileName, funnel, topCompanies, timestamp } = req.body;
  if (!personId) return res.status(400).json({ error: 'personId required' });
  const history = loadScanHistory();
  history.unshift({
    personId,
    profileName: profileName || 'Scan',
    funnel: funnel || {},
    topCompanies: (topCompanies || []).slice(0, 10).map(c => ({ name: c.name, score: c._score || c.score || 0 })),
    timestamp: timestamp || Date.now(),
  });
  saveScanHistory(history);
  res.json({ success: true });
});

// Funding round alerts — cached, refreshes every 30 min
const FUNDING_ALERTS_CACHE_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'funding_alerts_cache.json');
let fundingAlertsCache = { alerts: [], lastRefresh: 0 };
try { if (fs.existsSync(FUNDING_ALERTS_CACHE_FILE)) fundingAlertsCache = JSON.parse(fs.readFileSync(FUNDING_ALERTS_CACHE_FILE, 'utf8')); } catch(e) {}

app.get('/api/alerts/funding-rounds', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';
  const cacheAge = Date.now() - (fundingAlertsCache.lastRefresh || 0);
  const CACHE_TTL = 30 * 60 * 1000; // 30 min

  // Serve cache if fresh
  if (!forceRefresh && cacheAge < CACHE_TTL && fundingAlertsCache.alerts.length >= 0) {
    return res.json({ alerts: fundingAlertsCache.alerts, cached: true, cacheAge: Math.round(cacheAge / 60000) });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!headers || !baseId) return res.json({ alerts: [] });

  try {
    // Fetch all pipeline companies
    const stages = ['BO', 'BORO', 'BORO-SM'];
    const allCompanies = [];
    for (const stage of stages) {
      const formula = encodeURIComponent(`{CRM Stage} = "${stage}"`);
      const r = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${formula}&maxRecords=200`, { headers });
      if (r.ok) {
        const data = await r.json();
        (data.records || []).forEach(rec => {
          allCompanies.push({
            company: rec.fields['Company'] || '',
            stage: rec.fields['CRM Stage'] || stage,
            website: rec.fields['Company Link'] || '',
            airtableFunding: rec.fields['Total Funding'] || '',
          });
        });
      }
    }

    if (!harmonicKey || allCompanies.length === 0) return res.json({ alerts: [] });

    // Batch lookup funding from Harmonic — call ourselves on localhost
    const port = process.env.PORT || 3001;
    const batchRes = await fetch(`http://localhost:${port}/api/harmonic/batch-funding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companies: allCompanies.map(c => ({ name: c.company, website: c.website })) }),
    });
    const batchData = batchRes.ok ? await batchRes.json() : { results: {} };

    // Find companies with funding rounds in last 30 days
    const alerts = [];
    const lookbackDays = parseInt(req.query.days) || 45; // Default 45 days
    const cutoffDate = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);

    for (const c of allCompanies) {
      const hd = batchData.results?.[c.company];
      if (!hd || !hd.last_round_date) continue;
      if (hd.last_round_date >= cutoffDate) {
        alerts.push({
          company: c.company,
          stage: c.stage,
          round: hd.last_round || hd.stage || 'Unknown',
          amount: hd.last_round_amount || null,
          totalFunding: hd.funding_total || null,
          date: hd.last_round_date,
          logo: hd.logo_url || '',
        });
      }
    }

    alerts.sort((a, b) => b.date.localeCompare(a.date));
    // Cache results
    fundingAlertsCache = { alerts, lastRefresh: Date.now() };
    try { fs.writeFileSync(FUNDING_ALERTS_CACHE_FILE, JSON.stringify(fundingAlertsCache)); } catch(e) {}
    console.log(`[FundingAlerts] Refreshed: ${alerts.length} alerts`);
    res.json({ alerts, cached: false });
  } catch (e) {
    console.error('[FundingAlerts] Error:', e.message);
    // Serve stale cache on error
    if (fundingAlertsCache.alerts.length > 0) return res.json({ alerts: fundingAlertsCache.alerts, cached: true, stale: true });
    res.json({ alerts: [], error: e.message });
  }
});

// Force clear scan status for a person (or all)
app.post('/api/autoscan/clear-status/:personId?', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!global._scanStatus) global._scanStatus = {};
  if (req.params.personId) {
    const old = global._scanStatus[req.params.personId];
    global._scanStatus[req.params.personId] = { status: 'idle' };
    console.log(`[AutoScan] Force cleared status for ${req.params.personId} (was: ${JSON.stringify(old)})`);
    res.json({ success: true, cleared: req.params.personId, was: old });
  } else {
    const old = { ...global._scanStatus };
    global._scanStatus = {};
    console.log(`[AutoScan] Force cleared ALL scan statuses`);
    res.json({ success: true, cleared: 'all', was: old });
  }
});

// ==========================================
// DEEP SEARCH — Similar + AI Discovery + Scoring
// ==========================================
app.post('/api/deep-search', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let clientConnected = true;
  req.on('close', () => { clientConnected = false; });
  const safeWrite = (data) => { if (clientConnected) try { res.write(data); } catch (e) {} };
  const keepAlive = setInterval(() => safeWrite(': keepalive\n\n'), 5000);

  const sendProgress = (message, stage, pct, details) => {
    safeWrite(`data: ${JSON.stringify({ progress: { message, stage, pct: pct || 0, details } })}\n\n`);
  };

  const sendResult = (data) => {
    clearInterval(keepAlive);
    safeWrite(`data: ${JSON.stringify(data)}\n\n`);
    if (clientConnected) try { res.end(); } catch (e) {}
  };

  try {
    const harmonicKey = req.headers['x-harmonic-key'] || process.env.HARMONIC_API_KEY;
    const anthropicKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;
    if (!harmonicKey || !anthropicKey) return sendResult({ error: 'API keys required' });

    const { baselines, tier, keywords, industries, notes } = req.body;
    if (!baselines?.length) return sendResult({ error: 'At least one baseline company required' });

    const tierKey = tier || 'standard';
    console.log(`[DeepSearch] Starting ${tierKey} search with ${baselines.length} baselines: ${baselines.map(b => b.name).join(', ')}`);

    // STEP 1: Fetch similar companies from Harmonic for each baseline
    sendProgress('Finding similar companies from Harmonic...', 'import', 5);
    let allSimilar = [];
    const seenNames = new Set();

    for (const baseline of baselines) {
      let rawResults = [];
      try {
        const id = baseline.id;
        if (id) {
          const url = `${HARMONIC_BASE}/search/similar_companies/${id}?size=100`;
          const r = await fetch(url, { headers: { apikey: harmonicKey } });
          if (r.ok) {
            const data = await r.json();
            rawResults = Array.isArray(data) ? data : (data.results || data.similar_companies || data.companies || []);
          }
        }
        if (rawResults.length === 0 && baseline.name) {
          const lookupRes = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(baseline.name)}&size=1`, { headers: { apikey: harmonicKey } });
          if (lookupRes.ok) {
            const lookupData = await lookupRes.json();
            const match = (lookupData.results || [])[0];
            if (match) {
              const matchId = match.id || (match.entity_urn || '').split(':').pop();
              if (matchId) {
                const r2 = await fetch(`${HARMONIC_BASE}/search/similar_companies/${matchId}?size=100`, { headers: { apikey: harmonicKey } });
                if (r2.ok) {
                  const data = await r2.json();
                  rawResults = Array.isArray(data) ? data : (data.results || data.similar_companies || data.companies || []);
                }
              }
            }
          }
        }
      } catch (e) {
        console.error(`[DeepSearch] Harmonic similar error for ${baseline.name}:`, e.message);
      }

      // Extract IDs and dedup
      const alreadyFull = rawResults[0] && typeof rawResults[0] === 'object' && rawResults[0].name;
      if (alreadyFull) {
        for (const c of rawResults) {
          const n = (c.name || '').toLowerCase().trim();
          if (n && !seenNames.has(n)) { seenNames.add(n); allSimilar.push(gqlToCard(c)); }
        }
      } else {
        const ids = rawResults.map(r => {
          if (typeof r === 'string') return r.includes(':') ? r.split(':').pop() : r;
          if (typeof r === 'number') return r;
          return r.id || (r.entity_urn || r.entityUrn || '').split(':').pop() || null;
        }).filter(Boolean);
        if (ids.length > 0) {
          const enriched = await gqlEnrichCompanies(ids, harmonicKey);
          for (const c of enriched) {
            const card = gqlToCard(c);
            const n = (card.name || '').toLowerCase().trim();
            if (n && !seenNames.has(n)) { seenNames.add(n); allSimilar.push(card); }
          }
        }
      }

      sendProgress(`Found ${allSimilar.length} similar companies so far...`, 'import', 15);
    }

    // Drop backburned companies AND per-user-hidden before AI pre-screen — saves token spend
    const beforeBurn = allSimilar.length;
    allSimilar = filterBackburn(allSimilar);
    const deepHideIdx = buildUserHideIndex(resolvePersonId(req));
    allSimilar = filterUserHidden(allSimilar, deepHideIdx);
    if (beforeBurn !== allSimilar.length) {
      console.log(`[DeepSearch/Filter] Dropped ${beforeBurn - allSimilar.length} (backburn+user-hide), ${allSimilar.length} remain`);
    }

    console.log(`[DeepSearch] Collected ${allSimilar.length} unique similar companies`);
    sendProgress(`${allSimilar.length} companies from Harmonic. Starting AI screening...`, 'screen', 20);

    // Build context string for user criteria
    const contextParts = [];
    if (keywords) contextParts.push(`Keywords/themes: ${keywords}`);
    if (industries) contextParts.push(`Industries/sectors: ${industries}`);
    if (notes) contextParts.push(`Additional criteria: ${notes}`);
    const userContext = contextParts.length > 0 ? contextParts.join('\n') : '';
    const baselineDesc = baselines.map(b => b.name).join(', ');

    // STEP 2: AI Pre-screen (Sonnet for quick/standard, Sonnet for deep/max)
    const screenModel = tierKey === 'quick' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514';
    const BATCH_SIZE = 50;
    const passedCompanies = [];

    for (let i = 0; i < Math.ceil(allSimilar.length / BATCH_SIZE); i++) {
      const batch = allSimilar.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
      const batchText = batch.map((c, idx) => {
        const parts = [`${i * BATCH_SIZE + idx + 1}. ${c.name}`];
        if (c.description) parts.push(`   ${(c.description || '').slice(0, 100)}`);
        if (c.funding_stage) parts.push(`   Stage: ${c.funding_stage}${c.funding_total ? ' $' + (c.funding_total/1e6).toFixed(1) + 'M' : ''}`);
        if (c.headcount) parts.push(`   Team: ${c.headcount}`);
        if (c.location) parts.push(`   Location: ${c.location}`);
        return parts.join('\n');
      }).join('\n\n');

      const screenPrompt = `You are screening companies for similarity to: ${baselineDesc}.

${userContext ? `USER CRITERIA:\n${userContext}\n\n` : ''}TASK: For each company, verdict: PASS (similar/relevant) or CUT (not similar/not relevant).
Format: CompanyName — PASS — [brief reason] or CompanyName — CUT — [brief reason]

Focus on: business model similarity, market/industry overlap, stage fit, technology alignment.
Target ~30-40% pass rate. When in doubt, PASS (we'll score more carefully later).

COMPANIES:
${batchText}`;

      try {
        const sRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: screenModel, max_tokens: 3000, messages: [{ role: 'user', content: screenPrompt }] }),
        });

        if (sRes.ok) {
          const sData = await sRes.json();
          const sText = sData.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          const passNames = new Set();
          for (const m of sText.matchAll(/([^\n—\-]+?)\s*[—\-–]\s*PASS/gi)) {
            passNames.add(m[1].trim().replace(/\*\*/g, '').replace(/^\d+\.\s*/, '').toLowerCase().trim());
          }
          for (const c of batch) {
            const n = (c.name || '').toLowerCase().trim();
            const nClean = n.replace(/\s*\(.*?\)\s*/g, '').trim();
            if (passNames.has(n) || passNames.has(nClean) || (nClean.length >= 5 && [...passNames].some(p => p.length >= 5 && (p === nClean || p.startsWith(nClean) || nClean.startsWith(p))))) {
              passedCompanies.push(c);
            }
          }
        } else {
          // On failure, pass all through
          passedCompanies.push(...batch);
        }
      } catch (e) {
        passedCompanies.push(...batch);
      }

      const pct = 20 + Math.round((i + 1) / Math.ceil(allSimilar.length / BATCH_SIZE) * 30);
      sendProgress(`Screened ${Math.min((i + 1) * BATCH_SIZE, allSimilar.length)}/${allSimilar.length} — ${passedCompanies.length} passed`, 'screen', pct);
    }

    console.log(`[DeepSearch] Screening: ${allSimilar.length} → ${passedCompanies.length} passed`);

    // STEP 3: Deep scoring with Claude
    const scoreModel = (tierKey === 'quick' || tierKey === 'standard') ? 'claude-sonnet-4-20250514' : 'claude-opus-4-6';
    const maxToScore = tierKey === 'quick' ? 20 : tierKey === 'standard' ? 30 : tierKey === 'deep' ? 50 : 80;
    const toScore = passedCompanies.slice(0, maxToScore);

    sendProgress(`Scoring top ${toScore.length} companies with ${scoreModel.includes('opus') ? 'Opus' : 'Sonnet'}...`, 'score', 55);

    const SCORE_BATCH = 15;
    const scoredCompanies = [];

    for (let i = 0; i < Math.ceil(toScore.length / SCORE_BATCH); i++) {
      const batch = toScore.slice(i * SCORE_BATCH, (i + 1) * SCORE_BATCH);
      const batchText = batch.map((c, idx) => {
        const parts = [`### ${i * SCORE_BATCH + idx + 1}. ${c.name}`];
        if (c.description) parts.push(`Description: ${(c.description || '').slice(0, 200)}`);
        if (c.website) parts.push(`Website: ${c.website}`);
        if (c.funding_stage) parts.push(`Stage: ${c.funding_stage}`);
        if (c.funding_total) parts.push(`Funding: $${(c.funding_total/1e6).toFixed(1)}M`);
        if (c.headcount) parts.push(`Team size: ${c.headcount}`);
        if (c.location) parts.push(`Location: ${c.location}`);
        if (c.founders?.length) parts.push(`Founders: ${c.founders.map(f => typeof f === 'string' ? f : f.name).filter(Boolean).join(', ')}`);
        return parts.join('\n');
      }).join('\n\n');

      const scorePrompt = `You are evaluating companies for how similar and relevant they are to: ${baselineDesc}.

${userContext ? `USER CRITERIA:\n${userContext}\n\n` : ''}For each company, provide:
1. A relevance score from 1-10 (10 = extremely similar/relevant to the baselines)
2. A brief 1-2 sentence analysis explaining the score

Format your response EXACTLY like:
COMPANY: [name]
SCORE: [1-10]
ANALYSIS: [brief analysis]
---

Score based on: business model similarity, market overlap, technology alignment, stage fit, team quality, traction signals.

COMPANIES TO SCORE:
${batchText}`;

      try {
        const sRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: scoreModel, max_tokens: 4000, messages: [{ role: 'user', content: scorePrompt }] }),
        });

        if (sRes.ok) {
          const sData = await sRes.json();
          const sText = sData.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

          // Parse scores
          const blocks = sText.split('---').filter(b => b.trim());
          for (const block of blocks) {
            const nameMatch = block.match(/COMPANY:\s*(.+)/i);
            const scoreMatch = block.match(/SCORE:\s*(\d+(?:\.\d+)?)/i);
            const analysisMatch = block.match(/ANALYSIS:\s*(.+)/is);
            if (nameMatch && scoreMatch) {
              const scoredName = nameMatch[1].trim().toLowerCase();
              const score = parseFloat(scoreMatch[1]);
              const analysis = analysisMatch ? analysisMatch[1].trim().split('\n')[0].trim() : '';
              // Find matching company
              const match = batch.find(c => (c.name || '').toLowerCase().trim() === scoredName || (c.name || '').toLowerCase().includes(scoredName) || scoredName.includes((c.name || '').toLowerCase()));
              if (match) {
                scoredCompanies.push({ ...match, _score: score, _analysis: analysis });
              }
            }
          }
        }
      } catch (e) {
        console.error(`[DeepSearch] Scoring error batch ${i}:`, e.message);
      }

      const pct = 55 + Math.round((i + 1) / Math.ceil(toScore.length / SCORE_BATCH) * 35);
      sendProgress(`Scored ${Math.min((i + 1) * SCORE_BATCH, toScore.length)}/${toScore.length} companies`, 'score', pct);
    }

    // Add unscored companies that passed screening but weren't scored
    const scoredNames = new Set(scoredCompanies.map(c => (c.name || '').toLowerCase()));
    for (const c of passedCompanies) {
      if (!scoredNames.has((c.name || '').toLowerCase())) {
        scoredCompanies.push({ ...c, _score: 0, _analysis: 'Not scored (outside top tier)' });
      }
    }

    // Sort by score
    scoredCompanies.sort((a, b) => (b._score || 0) - (a._score || 0));

    // STEP 4: Generate summary
    sendProgress('Generating search summary...', 'done', 95);
    const top5 = scoredCompanies.filter(c => (c._score || 0) > 0).slice(0, 5);
    let summaryText = '';
    if (top5.length > 0) {
      try {
        const summaryPrompt = `Briefly summarize (3-4 sentences) the results of a company similarity search.
Baselines: ${baselineDesc}
${userContext ? `Criteria: ${userContext}` : ''}
Top results: ${top5.map(c => `${c.name} (${c._score}/10)`).join(', ')}
Total companies screened: ${allSimilar.length}, passed: ${passedCompanies.length}, scored: ${scoredCompanies.filter(c => c._score > 0).length}

Focus on patterns, common themes among top matches, and any standout companies.`;

        const sumRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: summaryPrompt }] }),
        });
        if (sumRes.ok) {
          const sumData = await sumRes.json();
          summaryText = sumData.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        }
      } catch (e) {}
    }

    console.log(`[DeepSearch] Complete: ${scoredCompanies.length} results, top score: ${scoredCompanies[0]?._score || 0}`);

    sendResult({
      results: scoredCompanies.slice(0, 200),
      analysis: summaryText,
      funnel: {
        similar: allSimilar.length,
        screened: passedCompanies.length,
        scored: scoredCompanies.filter(c => c._score > 0).length,
      },
      baselines: baselines.map(b => b.name),
      tier: tierKey,
    });

  } catch (e) {
    clearInterval(keepAlive);
    console.error(`[DeepSearch] Fatal error:`, e.message);
    sendResult({ error: e.message });
  }
});

app.post('/api/autoscan', async (req, res) => {
  // Use SSE-style streaming to keep connection alive through Railway's proxy
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // CRITICAL: sends headers immediately to establish CORS

  // Track client connection state — scan continues even if client disconnects
  let clientConnected = true;
  req.on('close', () => { clientConnected = false; console.log(`[AutoScan] Client disconnected — scan continues server-side`); });

  // Safe write — ignores errors if client disconnected
  const safeWrite = (data) => { if (clientConnected) try { res.write(data); } catch (e) {} };

  // Helper to send keepalive pings
  const keepAlive = setInterval(() => {
    safeWrite(': keepalive\n\n');
  }, 5000);

  // Track active scan status in memory (survives tab close)
  if (!global._scanStatus) global._scanStatus = {};

  // These will be set inside try block
  let _personId = null;
  let _profile = null;

  const sendResult = (data) => {
    clearInterval(keepAlive);
    // Save result server-side FIRST — persists even if client disconnected
    if (_personId) {
      try {
        const resultsFile = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'last_scan_results.json');
        let allResults = {};
        try { allResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8')); } catch (e) {}
        allResults[_personId] = {
          ...data,
          results: (data.results || []).slice(0, 300),
          timestamp: Date.now(),
          profileName: _profile?.name || 'Scan',
        };
        fs.writeFileSync(resultsFile, JSON.stringify(allResults));
      } catch (e) { console.error('[ScanResults] Save error:', e.message); }
      global._scanStatus[_personId] = { status: 'done', finishedAt: Date.now(), profileName: _profile?.name || 'Scan' };
      // Auto-save to server-side scan history
      try {
        const hist = loadScanHistory();
        const allScored = (data.results || []).filter(c => (c._score || c.score || 0) > 0).sort((a,b) => (b._score||b.score||0) - (a._score||a.score||0));
        hist.unshift({
          personId: _personId,
          profileName: _profile?.name || 'Scan',
          funnel: data.funnel || {},
          topCompanies: allScored.map(c => ({ name: c.name, score: c._score || c.score || 0, logo_url: c.logo_url || null, description: (c.description || '').slice(0, 200), id: c.id || null, website: c.website || null, funding_total: c.funding_total || 0, funding_stage: c.funding_stage || null })),
          analysis: (data.analysis || '').slice(0, 20000),
          savedSearchMeta: data.savedSearchMeta || null,
          totalResults: (data.results || []).length,
          timestamp: Date.now(),
        });
        saveScanHistory(hist);
        console.log(`[ScanHistory] Saved scan for ${_personId}: ${(data.results||[]).length} results, ${allScored.length} scored`);
      } catch(e) { console.error('[ScanHistory] Save error:', e.message); }
    }
    safeWrite(`data: ${JSON.stringify(data)}\n\n`);
    if (clientConnected) try { res.end(); } catch (e) {}
  };

  try {
    const harmonicKey = req.headers['x-harmonic-key'] || process.env.HARMONIC_API_KEY;
    const anthropicKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;

    if (!harmonicKey || !anthropicKey) {
      return sendResult({ error: 'API keys required' });
    }

    const { personId, profile, mode } = req.body;
    if (!personId || !profile) {
      return sendResult({ error: 'personId and profile required' });
    }
    _personId = personId;
    _profile = profile;

  const scanMode = mode || 'daily';
  console.log(`[AutoScan] Starting ${scanMode} scan for ${personId} (profileMode: ${profile.scanMode || 'keywords'})`);
  global._scanStatus[personId] = { status: 'scanning', startedAt: Date.now(), profileName: profile?.name || 'Scan', progress: 'Starting...', stage: 'import' };
  
  // Helper to update progress in status (so reconnecting frontends can see current stage)
  const updateProgress = (msg, stage) => {
    if (global._scanStatus[personId]) {
      global._scanStatus[personId].progress = msg;
      if (stage) global._scanStatus[personId].stage = stage;
    }
  };
  const authHeaders = { 'apikey': harmonicKey };

  // Load previously seen companies for this person (dismissed + DD additions)
  const allSeen = loadSeen();
  const seenSet = new Set(allSeen[personId] || []);
  
  // Also add all vetting pipeline companies to seen-set (already in DD)
  try {
    const vetting = loadVetting();
    for (const c of (vetting.companies || [])) {
      const cid = String(c.id || c.harmonic_id || '');
      if (cid) seenSet.add(cid);
      // Also add by name for fuzzy matching
      if (c.name) seenSet.add(c.name.toLowerCase().trim());
    }
    console.log(`[AutoScan] Seen-set: ${allSeen[personId]?.length || 0} dismissed + ${(vetting.companies || []).length} in DD = ${seenSet.size} total excluded`);
  } catch (e) {}

  // Also exclude all backburned companies — they should NEVER reappear in scans.
  // seenSet checks are by Harmonic ID (lines using `seenSet.has(id)`). Name/domain matches
  // get caught later by the final filterBackburn() pass on results.
  let _backburnSeenAdded = 0;
  for (const id of _backburnIdx.ids) { if (id) { seenSet.add(String(id)); _backburnSeenAdded++; } }
  console.log(`[AutoScan/Backburn] +${_backburnSeenAdded} backburn IDs added to seen-set (${_backburnIdx.names.size} names / ${_backburnIdx.domains.size} domains in final filter)`);

  // Per-user hide-for-me list — same treatment as backburn
  const _autoscanHideIdx = buildUserHideIndex(personId);
  if (_autoscanHideIdx) {
    let _userHideSeenAdded = 0;
    for (const id of _autoscanHideIdx.ids) { if (id) { seenSet.add(String(id)); _userHideSeenAdded++; } }
    console.log(`[AutoScan/UserHide] +${_userHideSeenAdded} per-user hidden IDs added to seen-set`);
  }

  let companyIds = [];
  let allUrns = new Set();
  let queries = [];
  let categoryMap = {}; // company ID → source category (for savedSearch mode)
  let savedSearchMeta = null; // metadata about saved search scan
  let allRawCards = []; // ALL raw companies from saved search (for progressive browsing)

  if (profile.scanMode === 'savedSearch' && profile.savedSearchIds?.length > 0) {
    // === SAVED SEARCH MODE ===
    console.log(`[AutoScan] Saved search mode: ${profile.savedSearchIds.length} searches`);
    const { companies: freshCompanies, totalBeforeDedup, totalAfterDedup } = await savedSearchScan(
      profile.savedSearchIds, authHeaders, seenSet
    );

    savedSearchMeta = {
      searchCount: profile.savedSearchIds.length,
      totalBeforeDedup,
      totalAfterDedup,
      freshCount: freshCompanies.length,
    };

    if (freshCompanies.length === 0) {
      return sendResult({
        results: [],
        message: 'No new companies from saved searches.',
        savedSearchMeta,
      });
    }

    // === NEW PIPELINE: Sonnet screens ALL raw companies FIRST, then enrich only survivors ===
    // This ensures we scan the full dataset even for 2000+ companies
    // freshCompanies has basic data: name, id, entity_urn, website, customer_type, logo_url, initialized_date
    
    // Build basic company text for Sonnet from raw Harmonic data (no GQL needed)
    const rawCards = freshCompanies.map(c => ({
      name: c.name || 'Unknown',
      id: c.id || c.entity_id || (c.entity_urn || '').split(':').pop(),
      description: c.description || c.short_description || '',
      website: c.website?.url || c.website?.domain || '',
      customer_type: c.customer_type || '',
      logo_url: c.logo_url || '',
      initialized_date: c.initialized_date || '',
      funding_total: c.funding?.funding_total || c.funding?.fundingTotal || 0,
      funding_stage: c.funding?.funding_stage || c.funding?.fundingStage || c.stage || '',
      headcount: c.headcount || c.employee_count || null,
      tags: c.tags || c.tagsV2?.map(t => t.displayValue) || [],
      _sourceCategory: c._sourceCategory || '',
      _isStealth: (c.name || '').toLowerCase().startsWith('stealth company'),
    }));
    
    // Early backburn + per-user hide filter — drop before Sonnet pre-screen pays for the tokens.
    // ID-based seenSet covers most cases; this catches name/domain-only matches.
    const _beforeBurnRaw = rawCards.length;
    let _filteredBurn = filterBackburn(rawCards);
    _filteredBurn = filterUserHidden(_filteredBurn, _autoscanHideIdx);
    if (_filteredBurn.length < _beforeBurnRaw) {
      safeWrite(`: 🚫 Filter removed ${_beforeBurnRaw - _filteredBurn.length} (backburn+hide) before screening\n\n`);
    }
    rawCards.length = 0;
    rawCards.push(..._filteredBurn);

    // Save all raw cards for progressive browsing (before any filtering)
    allRawCards = [...rawCards];

    // Sort: $10M+ funding to the back, stealth to the back, lowest funding first
    rawCards.sort((a, b) => {
      const aOver10M = (a.funding_total || 0) > 10000000;
      const bOver10M = (b.funding_total || 0) > 10000000;
      if (aOver10M && !bOver10M) return 1;
      if (!aOver10M && bOver10M) return -1;
      if (a._isStealth && !b._isStealth) return 1;
      if (!a._isStealth && b._isStealth) return -1;
      return (a.funding_total || 0) - (b.funding_total || 0);
    });
    
    // Apply pre-screen cap for ultra/micro tiers
    const prescreenCapMap = { full: null, balanced: null, economy: null, ultra: 500, micro: 150 };
    const prescreenCap = prescreenCapMap[profile.scanTier || 'full'] || null;
    let prescreenCards = rawCards;
    if (prescreenCap && rawCards.length > prescreenCap) {
      prescreenCards = rawCards.slice(0, prescreenCap);
      console.log(`[AutoScan] Tier ${profile.scanTier}: pre-screen capped at ${prescreenCap} (skipping ${rawCards.length - prescreenCap})`);
      safeWrite(`: Tier ${profile.scanTier}: screening ${prescreenCap} of ${rawCards.length} companies (${rawCards.length - prescreenCap} skipped)\n\n`);
    }
    
    console.log(`[AutoScan] PRE-ENRICH SONNET: Screening ${prescreenCards.length} raw companies...`);
    safeWrite(`: Screening ${prescreenCards.length} companies with Sonnet (before enrichment)...\n\n`);
    updateProgress(`Screening ${prescreenCards.length} companies with Sonnet`, "prescreen");

    // Build category map for all companies
    freshCompanies.forEach(c => {
      const id = String(c.id || c.entity_id || (c.entity_urn || '').split(':').pop());
      categoryMap[id] = c._sourceCategory;
    });

    // Sonnet pre-screen on RAW data (no GQL enrichment needed)
    const SONNET_PRESCREEN_BATCH = 150; // Large batches — raw data is compact
    const prescreenPassIds = new Set();
    let prescreenAnalysis = '';
    
    // Fetch portfolio context for Sonnet
    const portfolioContextEarly = await fetchPortfolioContext();
    
    for (let si = 0; si < Math.ceil(prescreenCards.length / SONNET_PRESCREEN_BATCH); si++) {
      const batch = prescreenCards.slice(si * SONNET_PRESCREEN_BATCH, (si + 1) * SONNET_PRESCREEN_BATCH);
      const batchText = batch.map((c, i) => {
        const parts = [`${si * SONNET_PRESCREEN_BATCH + i + 1}. ${c.name}`];
        if (c.description) parts.push(`   ${c.description.slice(0, 80)}`);
        if (c.funding_stage) parts.push(`   Stage: ${c.funding_stage}${c.funding_total ? ' $' + (c.funding_total/1e6).toFixed(1) + 'M' : ''}`);
        if (c.headcount) parts.push(`   Team: ${c.headcount}`);
        if (c.tags?.length) parts.push(`   ${c.tags.slice(0, 3).join(', ')}`);
        if (c._sourceCategory) parts.push(`   Source: ${c._sourceCategory}`);
        return parts.join('\n');
      }).join('\n\n');

      const prescreenPrompt = `You are a rapid deal screener for Daxos Capital ($100K-$250K checks, Pre-Seed/Seed, crypto/DeFi/fintech/betting/AI focus).

${portfolioContextEarly ? portfolioContextEarly : ''}

TASK: For each company, one-line verdict: PASS or CUT.
Format: CompanyName — PASS — [reason] or CompanyName — CUT — [reason]

PASS criteria (need 2+): right sector, <$5M raised, traction signal, portfolio affinity, strong founders.
CUT aggressively — target 15-20% pass rate. When in doubt, CUT.
STEALTH COMPANIES: Any company named "Stealth Company (Person Name)" should be CUT by default. These are pre-launch founders with NO product, NO traction, NO revenue. Only PASS a stealth company if the founder is a REPEAT FOUNDER who previously raised $10M+ AND is in crypto/fintech/betting. This should be extremely rare — expect 95%+ of stealth companies to be CUT.
Companies with $10M+ funding: strong bias toward CUT unless exceptional fit.
${profile.antiKeywords ? `AUTO-CUT: ${profile.antiKeywords}` : ''}
${profile.keywords ? `PRIORITIZE: ${profile.keywords}` : ''}

COMPANIES:
${batchText}`;

      try {
        safeWrite(`: Sonnet pre-screen batch ${si + 1}/${Math.ceil(prescreenCards.length / SONNET_PRESCREEN_BATCH)} — ${prescreenPassIds.size} passed so far\n\n`);
        const sRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 3000,
            messages: [{ role: 'user', content: prescreenPrompt }],
          }),
        });
        
        if (sRes.ok) {
          const sData = await sRes.json();
          const sText = sData.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          prescreenAnalysis += `\n## Pre-Screen Batch ${si + 1}\n${sText}\n`;
          
          // Parse PASS names
          for (const m of sText.matchAll(/([^\n—\-]+?)\s*[—\-–]\s*PASS/gi)) {
            const name = m[1].trim().replace(/\*\*/g, '').replace(/^\d+\.\s*/, '').toLowerCase().trim();
            if (name.length > 1) prescreenPassIds.add(name);
          }
          
          // Stream fun verdicts
          const verdictLines = sText.split('\n').filter(l => l.includes('PASS') || l.includes('CUT')).slice(0, 6);
          const funCuts = ['👎 nah', '🗑️ next', '😴 boring', '🚫 pass', '💀 dead', '🤷 meh'];
          const funPasses = ['🔥 hot', '👀 interesting', '💎 gem?', '🚀 potential', '⭐ nice', '🎯 match'];
          for (const line of verdictLines) {
            const isPASS = line.includes('PASS');
            const compName = line.split(/\s*[—\-–]\s*/)[0].replace(/\*\*/g, '').replace(/^\d+\.\s*/, '').trim().slice(0, 30);
            const reason = line.split(/\s*[—\-–]\s*/).slice(2).join(' ').trim().slice(0, 50);
            const fun = isPASS ? funPasses[Math.floor(Math.random() * funPasses.length)] : funCuts[Math.floor(Math.random() * funCuts.length)];
            if (compName.length > 2) safeWrite(`: ${isPASS ? '✅' : '❌'} ${compName} — ${reason || fun}\n\n`);
          }
          
          console.log(`[AutoScan] Pre-screen batch ${si + 1}: ${batch.length} screened, ${prescreenPassIds.size} total passed`);
        } else {
          console.error(`[AutoScan] Pre-screen batch ${si + 1} error: ${sRes.status}`);
          // On failure, pass all through
          batch.forEach(c => prescreenPassIds.add((c.name || '').toLowerCase().trim()));
        }
      } catch (e) {
        console.error(`[AutoScan] Pre-screen batch ${si + 1} exception:`, e.message);
        batch.forEach(c => prescreenPassIds.add((c.name || '').toLowerCase().trim()));
      }
      
      if (si + 1 < Math.ceil(prescreenCards.length / SONNET_PRESCREEN_BATCH)) await sleep(100);
    }
    
    console.log(`[AutoScan] PRE-SCREEN COMPLETE: ${prescreenCards.length} → ${prescreenPassIds.size} passed (${((prescreenPassIds.size / prescreenCards.length) * 100).toFixed(0)}%)`);
    safeWrite(`: Pre-screen done — ${prescreenPassIds.size} of ${prescreenCards.length} survived (${((prescreenPassIds.size / prescreenCards.length) * 100).toFixed(0)}%) — enriching ${companyIds.length} companies...\n\n`);
    updateProgress(`Enriching ${companyIds.length} companies via Harmonic`, "enrich");
    
    // Only enrich the Sonnet survivors
    companyIds = rawCards
      .filter(c => {
        const n = (c.name || '').toLowerCase().trim();
        const noParen = n.replace(/\s*\(.*?\)\s*/g, '').trim();
        return prescreenPassIds.has(n) || prescreenPassIds.has(noParen) ||
          (noParen.length >= 5 && [...prescreenPassIds].some(p => p.length >= 5 && (p === noParen || p.startsWith(noParen) || noParen.startsWith(p))));
      })
      .map(c => String(c.id))
      .filter(Boolean);

    console.log(`[AutoScan] Enriching ${companyIds.length} Sonnet survivors via GQL...`);

  } else {
    // === EXISTING KEYWORD MODE (unchanged) ===
    queries = profileToQueries(profile, scanMode);
    console.log(`[AutoScan] Queries for ${personId}:`, queries);

    for (const q of queries) {
      try {
        const searchUrl = `${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(q)}&size=50`;
        const searchRes = await fetch(searchUrl, { headers: authHeaders });
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          (searchData.results || []).forEach((r) => {
            if (r.urn) allUrns.add(r.urn);
          });
          console.log(`[AutoScan] Query "${q.slice(0, 40)}..." → ${searchData.results?.length || 0} results`);
        }
        await sleep(100);
      } catch (e) {
        console.error(`[AutoScan] Query error:`, e.message);
      }
    }

    console.log(`[AutoScan] Total unique URNs: ${allUrns.size}`);

    companyIds = [...allUrns]
      .map((urn) => urn.split(':').pop())
      .filter((id) => !seenSet.has(id));

    console.log(`[AutoScan] New companies (not dismissed): ${companyIds.length}`);
  }

  if (companyIds.length === 0) {
    return sendResult({ results: [], message: 'No new companies found. Try broadening your preferences.' });
  }

  // Fetch details via GraphQL — only enrich Sonnet survivors (already filtered)
  const scanTierEarly = profile.scanTier || 'full';
  console.log(`[AutoScan] Enriching ${companyIds.length} companies in GQL batches (tier: ${scanTierEarly})...`);
  updateProgress(`Enriching ${companyIds.length} companies (GQL)`, "enrich");
  const GQL_BATCH_SIZE = 30;
  let fullCompanies = [];
  for (let i = 0; i < companyIds.length; i += GQL_BATCH_SIZE) {
    const batch = companyIds.slice(i, i + GQL_BATCH_SIZE);
    try {
      const gqlBatch = await gqlEnrichCompanies(batch, authHeaders.apikey);
      fullCompanies.push(...gqlBatch.map(c => gqlToCard(c)));
      console.log(`[AutoScan] GQL batch ${Math.floor(i/GQL_BATCH_SIZE)+1}: enriched ${gqlBatch.length} (total: ${fullCompanies.length})`);
      safeWrite(`: Enriching ${fullCompanies.length}/${companyIds.length} companies...\n\n`);
    } catch (e) {
      console.error(`[AutoScan] GQL batch error:`, e.message);
    }
    if (i + GQL_BATCH_SIZE < companyIds.length) await sleep(200);
  }

  console.log(`[AutoScan] GQL enriched ${fullCompanies.length} total companies`);

  // CRM: Tag companies with their CRM stage (BO/BORO/SM/Warm) and exclude portcos
  let crmFilteredCompanies = fullCompanies;
  try {
    const crmStageMap = await fetchCrmCompanyNames();
    if (crmStageMap.size > 0) {
      const beforeCount = crmFilteredCompanies.length;
      crmFilteredCompanies = crmFilteredCompanies.filter(c => {
        const name = (c.name || '').toLowerCase().trim();
        // Exclude portcos from ALL searches
        if (isPortco(c)) {
          console.log(`[AutoScan] Portco filter: excluded "${c.name}"`);
          return false;
        }
        // Tag CRM companies with their stage (don't remove)
        const stage = crmStageMap.get(name);
        if (stage) {
          c._crmStage = stage;
          console.log(`[AutoScan] CRM tag: "${c.name}" → ${stage}`);
        }
        return true;
      });
      const removed = beforeCount - crmFilteredCompanies.length;
      if (removed > 0) {
        console.log(`[AutoScan] Portco exclusion: removed ${removed} portfolio companies`);
      }
      const tagged = crmFilteredCompanies.filter(c => c._crmStage).length;
      if (tagged > 0) {
        console.log(`[AutoScan] CRM tagged: ${tagged} companies with existing CRM stage`);
      }
    }
  } catch (e) {
    console.error('[AutoScan] CRM filter error (continuing):', e.message);
  }

  // Daily mode: filter to companies added to Harmonic in last N days
  // Skip time filter for savedSearch mode — those results are already curated
  let filteredCompanies = crmFilteredCompanies;
  if (scanMode === 'daily' && profile.scanMode !== 'savedSearch') {
    const timeframeDays = profile.timeframeDays || 2; // Default 2 days (48h)
    const primaryCutoff = Date.now() - (timeframeDays * 24 * 60 * 60 * 1000);
    const fallbackCutoff = Date.now() - (Math.max(timeframeDays * 3, 14) * 24 * 60 * 60 * 1000); // 3x or 14d fallback
    
    // Try primary timeframe first
    let primaryFiltered = crmFilteredCompanies.filter(c => {
      const initDate = c.initialized_date || c.created_at;
      if (!initDate) return false;
      const ts = new Date(initDate).getTime();
      return !isNaN(ts) && ts > primaryCutoff;
    });
    
    if (primaryFiltered.length >= 3) {
      filteredCompanies = primaryFiltered;
      console.log(`[AutoScan] Timeframe ${timeframeDays}d filter: ${crmFilteredCompanies.length} → ${filteredCompanies.length}`);
    } else {
      // Fall back to wider window
      let fallbackFiltered = crmFilteredCompanies.filter(c => {
        const initDate = c.initialized_date || c.created_at;
        if (!initDate) return false;
        const ts = new Date(initDate).getTime();
        return !isNaN(ts) && ts > fallbackCutoff;
      });
      
      if (fallbackFiltered.length >= 3) {
        filteredCompanies = fallbackFiltered;
        console.log(`[AutoScan] Timeframe fallback ${Math.max(timeframeDays * 3, 14)}d: ${crmFilteredCompanies.length} → ${filteredCompanies.length}`);
      } else {
        filteredCompanies = crmFilteredCompanies;
        console.log(`[AutoScan] Timeframe: no recent companies, using all ${crmFilteredCompanies.length}`);
      }
    }
  }

  if (filteredCompanies.length === 0) {
    return sendResult({ results: [], message: 'Found URNs but could not fetch details.' });
  }

  // Companies are already in card format from gqlToCard
  const isSavedSearchMode = profile.scanMode === 'savedSearch';

  // Fetch portfolio context for scoring (cached, 6h TTL)
  let portfolioContext = '';
  try {
    portfolioContext = await fetchPortfolioContext();
    if (portfolioContext) console.log(`[AutoScan] Portfolio context loaded (${portfolioContext.length} chars)`);
  } catch (e) { console.error('[AutoScan] Portfolio context error:', e.message); }

  // For savedSearch mode, add category tags to each company card
  if (isSavedSearchMode && Object.keys(categoryMap).length > 0) {
    filteredCompanies.forEach(c => {
      const id = String(c.id || '');
      if (categoryMap[id]) {
        c._sourceCategory = categoryMap[id];
      }
    });
  }

  // === PRE-FILTER: Apply hard criteria before sending to Opus ===
  let preFiltered = filteredCompanies;

  // Backburn + per-user hide early-cut — before VC/anti-keyword/Opus. Same defense-in-depth.
  const _beforeBurnPre = preFiltered.length;
  preFiltered = filterBackburn(preFiltered);
  preFiltered = filterUserHidden(preFiltered, _autoscanHideIdx);
  if (preFiltered.length < _beforeBurnPre) {
    safeWrite(`: 🚫 Filter cut ${_beforeBurnPre - preFiltered.length} (backburn+hide) before scoring\n\n`);
  }

  const antiKeywords = (profile.antiKeywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  
  // Hard exclusion: VC firms, investment funds, hedge funds (not investable startups)
  // Only match against description + tags, NOT name (avoids false positives like "Sharpe", "Epoch")
  const VC_FUND_KEYWORDS = ['venture capital', 'venture fund', 'investment firm', 'hedge fund', 'private equity', 'asset management firm', 'fund manager', 'capital management', 'portfolio management', 'wealth management', 'family office', 'fund of funds', 'limited partners', 'general partner', 'investment management', 'venture partner', 'investing in startups', 'our portfolio companies', 'we invest in'];
  
  const beforeVC = preFiltered.length;
  preFiltered = preFiltered.filter(c => {
    // Skip stealth companies — they have minimal descriptions, don't filter them
    if ((c.name || '').toLowerCase().startsWith('stealth company')) return true;
    // Only check description and tags, not name
    const text = `${c.description || ''} ${(c.tags || []).join(' ')}`.toLowerCase();
    const isVCFund = VC_FUND_KEYWORDS.some(kw => text.includes(kw));
    if (isVCFund) {
      console.log(`[AutoScan] VC/Fund filter: CUT "${c.name}" — matches fund keyword`);
      safeWrite(`: 🏦 CUT "${c.name}" — this is a fund, not a startup\n\n`);
    }
    return !isVCFund;
  });
  if (preFiltered.length < beforeVC) console.log(`[AutoScan] VC/Fund filter: ${beforeVC} → ${preFiltered.length} (removed ${beforeVC - preFiltered.length} funds)`);

  // User anti-keywords
  if (antiKeywords.length > 0) {
    const before = preFiltered.length;
    preFiltered = preFiltered.filter(c => {
      const text = `${c.name} ${c.description} ${(c.tags || []).join(' ')}`.toLowerCase();
      return !antiKeywords.some(kw => text.includes(kw));
    });
    if (preFiltered.length < before) console.log(`[AutoScan] Anti-keyword filter: ${before} → ${preFiltered.length}`);
  }

  // Sort: real companies with low funding first, stealth companies pushed to back
  preFiltered.sort((a, b) => {
    const aIsStealth = (a.name || '').toLowerCase().startsWith('stealth company');
    const bIsStealth = (b.name || '').toLowerCase().startsWith('stealth company');
    // Stealth companies go to the back
    if (aIsStealth && !bIsStealth) return 1;
    if (!aIsStealth && bIsStealth) return -1;
    // Among non-stealth, sort by funding ascending
    const aFund = a.funding_total || 0;
    const bFund = b.funding_total || 0;
    return aFund - bFund;
  });
  
  // Flag stealth companies so Sonnet/Opus can deprioritize them
  preFiltered.forEach(c => {
    if ((c.name || '').toLowerCase().startsWith('stealth company')) {
      c._isStealth = true;
    }
  });

  console.log(`[AutoScan] Pre-filtered to ${preFiltered.length} companies (stealth companies pushed to back)`);
  safeWrite(`: Filtering ${preFiltered.length} enriched companies (removed ${fullCompanies.length - preFiltered.length})...\n\n`);

  const companyCards = preFiltered;

  const prefSummary = isSavedSearchMode
    ? [
        `Scan Mode: Saved Searches`,
        `Searches: ${(profile.savedSearchIds || []).map(s => `"${s.name}" (${s.category || s.name})`).join(', ')}`,
        profile.sectors?.length ? `Preferred sectors: ${profile.sectors.join(', ')}` : '',
        profile.stages?.length ? `Target stages: ${profile.stages.join(', ')}` : '',
        profile.geos?.length ? `Geography: ${profile.geos.join(', ')}` : '',
        profile.models?.length ? `Business models: ${profile.models.join(', ')}` : '',
        profile.teamPrefs?.length ? `Team prefs: ${profile.teamPrefs.join(', ')}` : '',
        profile.checkSize?.length ? `Check size: ${profile.checkSize.join(', ')}` : '',
        profile.signals?.length ? `Key signals: ${profile.signals.join(', ')}` : '',
        profile.maxValuation ? `Max valuation: ${profile.maxValuation}` : '',
        profile.maxRaised ? `Max raised: ${profile.maxRaised}` : '',
        profile.foundedAfter ? `Founded after: ${profile.foundedAfter}` : '',
        profile.keywords ? `Priority keywords: ${profile.keywords}` : '',
        profile.antiKeywords ? `Exclude/avoid: ${profile.antiKeywords}` : '',
        profile.notes ? `IMPORTANT investor notes: ${profile.notes}` : '',
      ].filter(Boolean).join('\n')
    : [
    profile.sectors?.length ? `Sectors: ${profile.sectors.join(', ')}` : '',
    profile.stages?.length ? `Stages: ${profile.stages.join(', ')}` : '',
    profile.geos?.length ? `Geography: ${profile.geos.join(', ')}` : '',
    profile.models?.length ? `Business models: ${profile.models.join(', ')}` : '',
    profile.teamPrefs?.length ? `Team prefs: ${profile.teamPrefs.join(', ')}` : '',
    profile.checkSize?.length ? `Check size: ${profile.checkSize.join(', ')}` : '',
    profile.signals?.length ? `Key signals: ${profile.signals.join(', ')}` : '',
    profile.maxValuation ? `Max valuation: ${profile.maxValuation}` : '',
    profile.maxRaised ? `Max raised: ${profile.maxRaised}` : '',
    profile.foundedAfter ? `Founded after: ${profile.foundedAfter}` : '',
    profile.keywords ? `Keywords: ${profile.keywords}` : '',
    profile.antiKeywords ? `Exclude: ${profile.antiKeywords}` : '',
    profile.notes ? `Notes: ${profile.notes}` : '',
  ].filter(Boolean).join('\n');

  // === HELPER: Build company data text for a batch ===
  function buildCompanyText(cards, startIdx) {
    return cards.map((c, i) => {
      const parts = [`${startIdx + i + 1}. **${c.name}**`];
      if (c._sourceCategory) parts.push(`   Source: ${c._sourceCategory}`);
      if (c.description) parts.push(`   Desc: ${c.description.slice(0, 250)}`);
      if (c.website) parts.push(`   Web: ${c.website}`);
      if (c.funding_stage) parts.push(`   Stage: ${c.funding_stage}`);
      if (c.funding_total) parts.push(`   Total Raised: $${c.funding_total >= 1e6 ? (c.funding_total/1e6).toFixed(1)+'M' : (c.funding_total/1e3).toFixed(0)+'K'}`);
      if (c.last_round_amount) parts.push(`   Last Round: $${c.last_round_amount >= 1e6 ? (c.last_round_amount/1e6).toFixed(1)+'M' : (c.last_round_amount/1e3).toFixed(0)+'K'}`);
      if (c.funding_date) parts.push(`   Last Funding: ${c.funding_date}`);
      if (c.headcount) parts.push(`   Team Size: ${c.headcount}`);
      if (c.location) parts.push(`   Location: ${c.location}`);
      if (c.founded) parts.push(`   Founded: ${c.founded}`);
      if (c.investors?.length) parts.push(`   Investors: ${c.investors.join(', ')}`);
      if (c.lead_investors?.length) parts.push(`   Lead Investors: ${c.lead_investors.join(', ')}`);
      if (c.founders?.length) {
        c.founders.forEach(f => {
          const founderLine = [`   👤 Founder: ${f.name}`];
          if (f.headline) founderLine.push(`      Headline: ${f.headline}`);
          if (f.careerPath) founderLine.push(`      Career: ${f.careerPath}`);
          if (f.education?.length) founderLine.push(`      Education: ${f.education.map(e => `${e.degree || ''} ${e.field || ''} @ ${e.school}`.trim()).join(', ')}`);
          if (f.highlights?.length) founderLine.push(`      Notable: ${f.highlights.join('; ')}`);
          if (f.linkedin) founderLine.push(`      LinkedIn: ${f.linkedin}`);
          parts.push(founderLine.join('\n'));
        });
      }
      if (c.founder_prior_companies?.length) parts.push(`   Founder alumni of: ${c.founder_prior_companies.join(', ')}`);
      if (c.prior_companies?.length) parts.push(`   Leadership from: ${c.prior_companies.join(', ')}`);
      if (c.highlights?.length) parts.push(`   Highlights: ${c.highlights.slice(0, 3).join('; ')}`);
      if (c.employee_highlights?.length) parts.push(`   Team Highlights: ${c.employee_highlights.slice(0, 2).join('; ')}`);
      if (c.tags?.length) parts.push(`   Tags: ${c.tags.join(', ')}`);
      const t = c.traction || {};
      const tMetrics = [];
      if (t.webTraffic) tMetrics.push(`Web: ${t.webTraffic}/mo`);
      if (t.webGrowth30d) tMetrics.push(`Web 30d: ${t.webGrowth30d > 0 ? '+' : ''}${t.webGrowth30d}%`);
      if (t.hcGrowth30d) tMetrics.push(`HC 30d: ${t.hcGrowth30d > 0 ? '+' : ''}${t.hcGrowth30d}%`);
      if (t.engGrowth30d) tMetrics.push(`Eng 30d: ${t.engGrowth30d > 0 ? '+' : ''}${t.engGrowth30d}%`);
      if (tMetrics.length) parts.push(`   Traction: ${tMetrics.join(', ')}`);
      if (c.socials?.linkedin) parts.push(`   LinkedIn: ${c.socials.linkedin}`);
      if (c.socials?.twitter) parts.push(`   Twitter: ${c.socials.twitter}`);
      return parts.join('\n');
    }).join('\n\n');
  }

  // === TWO-TIER SCORING: Sonnet pre-filter → Opus deep analysis ===
  const SONNET_BATCH_SIZE = 60; // Sonnet is fast+cheap, can handle larger batches
  const OPUS_BATCH_SIZE = 40;
  
  console.log(`[AutoScan] TIER 1: Sonnet pre-filter on ${companyCards.length} companies (batches of ${SONNET_BATCH_SIZE})`);
  
  // TIER 1: Sonnet quick filter — Score 1-5, PASS or CUT each company
  const sonnetPassNames = new Set();
  const sonnetBatches = Math.ceil(companyCards.length / SONNET_BATCH_SIZE);
  let sonnetAnalysisText = '';
  
  for (let si = 0; si < sonnetBatches; si++) {
    const batchStart = si * SONNET_BATCH_SIZE;
    const batch = companyCards.slice(batchStart, batchStart + SONNET_BATCH_SIZE);
    const batchText = buildCompanyText(batch, batchStart);
    
    const sonnetPrompt = `You are a quick-screen analyst for Daxos Capital ($100K-$250K checks, Pre-Seed/Seed).

Investor preferences:
${prefSummary}
${portfolioContext ? `\n${portfolioContext}\n` : ''}
TASK: For each company below, give a 1-line verdict. Format EXACTLY like this:
CompanyName — PASS — [5-word reason]
CompanyName — CUT — [5-word reason]

PASS = strong fit for this investor. Must meet AT LEAST TWO of these criteria:
  (a) Right sector match (crypto, DeFi, betting, AI, fintech, etc per preferences above)
  (b) Pre-Seed/Seed stage with <$5M raised
  (c) Clear traction signal (web growth, user growth, revenue)
  (d) Portfolio affinity with an existing CRM company (flag the match)
  (e) Strong founder pedigree (YC, top-tier company alumni, repeat founder)
CUT = does not meet 2+ criteria above, OR is wrong fit (wrong sector, too late stage, B2B enterprise SaaS, no differentiation, etc).
${profile.antiKeywords ? `\nAUTO-CUT any company matching these exclusions: ${profile.antiKeywords}` : ''}

BE VERY SELECTIVE — target passing only 15-20% of companies. Only the genuinely strong fits should survive. When in doubt, CUT.
STEALTH COMPANIES: Companies named "Stealth Company (Person Name)" are founders who haven't launched yet. Apply a -60% score bias — only PASS stealth companies if the founder has EXCEPTIONAL pedigree (top-tier company alumni + repeat founder + right sector). Do NOT count $0 funding as a positive signal for stealth companies. Most stealth companies should be CUT.
ALWAYS PASS companies with Web 30d growth ≥ +50% AND right sector — but still CUT if the company is in an excluded category (ecological/climate, donation/charity, carbon credits, VC funds).
Lean toward CUT if Web 30d growth ≤ -25% (declining traction) — BUT reduce this bias if the company matches a portfolio/CRM company.

COMPANIES:
${batchText}`;

    try {
      safeWrite(`: Sonnet screening batch ${si + 1}/${sonnetBatches} — ${sonnetPassNames.size} passed so far\n\n`);
      const sRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 3000,
          messages: [{ role: 'user', content: sonnetPrompt }],
        }),
      });
      
      if (sRes.ok) {
        const sData = await sRes.json();
        const sText = sData.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        sonnetAnalysisText += `\n## Sonnet Pre-Filter Batch ${si + 1}/${sonnetBatches}\n${sText}\n`;
        
        // Parse PASS companies
        const passMatches = sText.matchAll(/([^\n—\-]+?)\s*[—\-–]\s*PASS/gi);
        for (const m of passMatches) {
          const name = m[1].trim().replace(/\*\*/g, '').replace(/^\d+\.\s*/, '').replace(/🌐/g, '').toLowerCase().trim();
          if (name.length > 1) sonnetPassNames.add(name);
        }
        
        // Stream fun per-company verdicts to frontend
        const verdictLines = sText.split('\n').filter(l => l.includes('PASS') || l.includes('CUT')).slice(0, 8);
        const funCuts = ['👎 nah', '🗑️ next', '😴 boring', '🚫 pass', '💀 dead on arrival', '🤷 meh', '🪦 RIP', '👻 ghost this one'];
        const funPasses = ['🔥 hot', '👀 interesting', '💎 gem?', '🚀 potential', '⭐ looks good', '🎯 thesis match'];
        for (const line of verdictLines) {
          const isPASS = line.includes('PASS');
          const compName = line.split(/\s*[—\-–]\s*/)[0].replace(/\*\*/g, '').replace(/^\d+\.\s*/, '').trim().slice(0, 30);
          const reason = line.split(/\s*[—\-–]\s*/).slice(2).join(' ').trim().slice(0, 50);
          const fun = isPASS ? funPasses[Math.floor(Math.random() * funPasses.length)] : funCuts[Math.floor(Math.random() * funCuts.length)];
          if (compName.length > 2) {
            safeWrite(`: ${isPASS ? '✅' : '❌'} ${compName} — ${reason || fun}\n\n`);
          }
        }
        
        console.log(`[AutoScan] Sonnet batch ${si + 1}: ${batch.length} scored, ${sonnetPassNames.size} total PASSed so far`);
      } else {
        console.error(`[AutoScan] Sonnet batch ${si + 1} error: ${sRes.status}`);
        // On Sonnet failure, pass all through to Opus
        batch.forEach(c => sonnetPassNames.add((c.name || '').toLowerCase().trim()));
      }
    } catch (e) {
      console.error(`[AutoScan] Sonnet batch ${si + 1} exception:`, e.message);
      batch.forEach(c => sonnetPassNames.add((c.name || '').toLowerCase().trim()));
    }
    
    if (si + 1 < sonnetBatches) await sleep(500);
  }
  
  // Filter companyCards to only Sonnet PASSes (fuzzy match)
  const opusCandidates = companyCards.filter(c => {
    const n = (c.name || '').toLowerCase().trim();
    const noParen = n.replace(/\s*\(.*?\)\s*/g, '').trim();
    return sonnetPassNames.has(n) || sonnetPassNames.has(noParen) || 
      [...sonnetPassNames].some(p => p.includes(noParen) || noParen.includes(p));
  });
  
  console.log(`[AutoScan] TIER 1 COMPLETE: ${companyCards.length} → ${opusCandidates.length} passed Sonnet filter (${((opusCandidates.length / companyCards.length) * 100).toFixed(0)}%)`);
  
  // Scan tier determines how much Opus is used
  const scanTier = profile.scanTier || 'full';
  const TIER_CONFIG = {
    full:     { opusCap: 80, useOpus: true, sonnetRerank: false },
    balanced: { opusCap: 20, useOpus: true, sonnetRerank: true, rerankTop: 40 },
    economy:  { opusCap: 0,  useOpus: false, sonnetRerank: true, rerankTop: 40 },
    ultra:    { opusCap: 0,  useOpus: false, sonnetRerank: true, rerankTop: 20 },
    micro:    { opusCap: 0,  useOpus: false, sonnetRerank: false, rerankTop: 0 },
  };
  const tierCfg = TIER_CONFIG[scanTier] || TIER_CONFIG.full;
  console.log(`[AutoScan] Scan tier: ${scanTier} — Opus cap: ${tierCfg.opusCap}, Sonnet rerank: ${tierCfg.sonnetRerank}`);
  safeWrite(`: Sonnet complete — ${opusCandidates.length} passed (${((opusCandidates.length / companyCards.length) * 100).toFixed(0)}%) — ${tierCfg.useOpus ? 'starting Opus...' : 'Sonnet deep scoring...'}\n\n`);
    updateProgress(`Sonnet done — ${opusCandidates.length} passed — starting deep scoring`, "deepscore");
  
  // Cap Opus candidates based on tier
  const OPUS_CAP = tierCfg.opusCap;
  if (opusCandidates.length > OPUS_CAP) {
    console.log(`[AutoScan] Capping Opus candidates: ${opusCandidates.length} → ${OPUS_CAP} (saving ~$${((opusCandidates.length - OPUS_CAP) * 0.015).toFixed(2)})`);
    opusCandidates.length = OPUS_CAP;
  }

  // TIER 2: Deep analysis (Opus for full/balanced, Sonnet for economy)
  const analysisModel = tierCfg.useOpus ? 'claude-opus-4-6' : 'claude-sonnet-4-20250514';
  const analysisBatchSize = tierCfg.useOpus ? OPUS_BATCH_SIZE : 40;
  const totalBatches = Math.ceil(opusCandidates.length / analysisBatchSize);
  console.log(`[AutoScan] TIER 2: ${tierCfg.useOpus ? 'Opus' : 'Sonnet'} deep scoring on ${opusCandidates.length} companies (${totalBatches} batch${totalBatches !== 1 ? 'es' : ''}) — tier: ${scanTier}`);

  const allBatchAnalyses = [sonnetAnalysisText];
  const scoreMap = {};
  const passSet = new Set();

  if (opusCandidates.length === 0 && companyCards.length > 0) {
    // Sonnet filtered everyone out — force top enriched companies through to Opus for scoring
    // This ensures DD always gets candidates from scans that have enriched results
    const forceCount = Math.min(companyCards.length, 10);
    console.log(`[AutoScan] Sonnet passed 0 — forcing top ${forceCount} enriched companies to Opus for scoring`);
    safeWrite(`: Sonnet filtered all — forcing top ${forceCount} to deep scoring\n\n`);
    opusCandidates.push(...companyCards.slice(0, forceCount));
  } else if (opusCandidates.length === 0) {
    console.log('[AutoScan] No companies passed Sonnet filter and no enriched cards — skipping deep scoring');
  }

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batchStart = batchIdx * analysisBatchSize;
    const batchCards = opusCandidates.slice(batchStart, batchStart + analysisBatchSize);
    const batchDataText = buildCompanyText(batchCards, batchStart);
    const batchLabel = totalBatches > 1 ? ` (Batch ${batchIdx + 1}/${totalBatches})` : '';

    const batchPrompt = isSavedSearchMode
      ? `You are a senior deal analyst at Daxos Capital ($100K-$250K checks, Pre-Seed/Seed focus).${batchLabel}

This team member's investment profile:
${prefSummary}
${portfolioContext ? `\n${portfolioContext}\n` : ''}
These ${batchCards.length} companies PASSED an initial screen and come from curated Harmonic saved searches.
${profile.savedSearchIds ? profile.savedSearchIds.map(s => {
  let line = `- "${s.name}" (${s.category || s.name})`;
  if (s.keywords) line += ` [keywords: ${s.keywords}]`;
  if (s.notes) line += ` [notes: ${s.notes}]`;
  return line;
}).join('\n') : ''}

USE THE INVESTOR'S NOTES, KEYWORDS, AND PER-SEARCH HINTS AS YOUR PRIMARY SCORING GUIDE.
Apply the AFFINITY SCORING RULES from the portfolio context above. Boost % varies by CRM stage (BO=+10%, BORO=+20%, BORO-SM=+35%, Warm=+27.5%). Use highest single boost, dont stack.
Also apply WEB TRACTION RULES from portfolio context: Growth 1-100%→boost=X/3, 101-150%→+40%, 151-225%→+55%, 226-375%→+70%, 376%+→+80%. Decline -1 to -25%→-10%, -26 to -50%→-20%, -51%+→-30% (reduce penalty if portfolio affinity). HARD EXCLUDE: ecology/climate/carbon/charity startups regardless of growth. Flag 🚀/📉. Stacks with affinity.
STEALTH COMPANIES: Apply -90% score penalty to any "Stealth Company (Person Name)". These are pre-launch founders with no product. Only score above 5 if founder has exceptional pedigree. Do NOT credit $0 funding as early-stage positive — it means nothing exists yet.

Score each company 1-10. Be decisive. FORMAT:

## SCORED COMPANIES
- **CompanyName** — Score: X/10 — Source: [category]
- Why THIS investor would care (1-2 sentences)
- Portfolio affinity: [if any, name the portco, stage, and why]
- Web traction: [flag 🚀 or 📉 with tier and adjusted score if applicable]
- Red flags

## FINAL PICKS
Top 5-10 ranked. Bold names + scores + 1-line pitch.

COMPANY DATA:
${batchDataText}`
      : `You are an AI deal scout for Daxos Capital ($100K-$250K checks, Pre-Seed/Seed focus).${batchLabel}

Investment preferences:
${prefSummary}
${portfolioContext ? `\n${portfolioContext}\n` : ''}
These ${batchCards.length} companies passed an initial filter. Score 1-10 against preferences.
Apply the AFFINITY SCORING RULES from the portfolio context above. Boost % varies by CRM stage (BO=+10%, BORO=+20%, BORO-SM=+35%, Warm=+27.5%). Use highest single boost, dont stack.
Also apply WEB TRACTION RULES: Growth 1-100%→boost=X/3, 101-150%→+40%, 151-225%→+55%, 226-375%→+70%, 376%+→+80%. Decline -1 to -25%→-10%, -26 to -50%→-20%, -51%+→-30% (reduce if portfolio affinity). HARD EXCLUDE ecology/climate/carbon/charity. Flag 🚀/📉. Stacks with affinity.
STEALTH COMPANIES: Apply -90% score penalty to any "Stealth Company (Person Name)". Only score above 5 if founder has exceptional pedigree.

## SCORED COMPANIES — **Name** — Score: X/10 + reasoning + portfolio affinity + web traction flags
## FINAL PICKS (Score 7+) — Bold names, scores, 1-line pitch.

COMPANY DATA:
${batchDataText}`;

    try {
      const modelLabel = tierCfg.useOpus ? 'Opus' : 'Sonnet';
      console.log(`[AutoScan] ${modelLabel} batch ${batchIdx + 1}/${totalBatches}: scoring ${batchCards.length} companies...`);
      safeWrite(`: ${modelLabel} deep scoring batch ${batchIdx + 1}/${totalBatches} — ${Object.keys(scoreMap).length} scored\n\n`);
      updateProgress(`Deep scoring batch ${batchIdx + 1}/${totalBatches}`, "deepscore");

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: analysisModel,
          max_tokens: 4000,
          messages: [{ role: 'user', content: batchPrompt }],
        }),
      });

      if (!claudeRes.ok) {
        const err = await claudeRes.text().catch(() => '');
        console.error(`[AutoScan] Opus batch ${batchIdx + 1} error: ${claudeRes.status} ${err.slice(0, 200)}`);
        allBatchAnalyses.push(`[Opus Batch ${batchIdx + 1} error: ${claudeRes.status}]`);
        continue;
      }

      const claudeData = await claudeRes.json();
      const batchAnalysis = claudeData.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      allBatchAnalyses.push(totalBatches > 1 ? `## === OPUS BATCH ${batchIdx + 1}/${totalBatches} (${batchCards.length} companies) ===\n\n${batchAnalysis}` : batchAnalysis);

      // Parse scores from this batch
      // Clean name helper — strip numbering, emojis, parens, whitespace
      const cleanName = (raw) => raw.replace(/🌐/g, '').replace(/\n/g, ' ').replace(/\(.*?\)/g, '').replace(/^\d+[\.\)]\s*/, '').trim().toLowerCase();

      // Strategy 1: "**Name** — Score: N/10"
      for (const m of batchAnalysis.matchAll(/\*\*(.{1,80}?)\*\*\s*[—\-–]\s*Score:\s*(\d+)\s*\/\s*10/gi)) {
        const name = cleanName(m[1]);
        if (name.length >= 2 && name.length < 50) scoreMap[name] = Math.max(scoreMap[name] || 0, parseInt(m[2]) || 0);
      }
      // Strategy 2: "Final Score: N/10" preceded by company header
      for (const m of batchAnalysis.matchAll(/Final Score:\s*(\d+)\s*\/\s*10/gi)) {
        const before = batchAnalysis.slice(Math.max(0, m.index - 2000), m.index);
        const nameMatch = [...before.matchAll(/###?\s*\d+\.?\s*\*?\*?(.+?)\*?\*?\s*[—\-–]/gi)].pop();
        if (nameMatch) {
          const name = cleanName(nameMatch[1].replace(/\*\*/g, ''));
          if (name.length >= 2 && name.length < 50) scoreMap[name] = Math.max(scoreMap[name] || 0, parseInt(m[1]) || 0);
        }
      }
      // Strategy 3: Table format "| N | Name | Score/10 |"
      for (const m of batchAnalysis.matchAll(/\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\/\s*10\s*\|/gi)) {
        const name = cleanName(m[1].replace(/\*\*/g, '').replace(/\[.*?\]/g, ''));
        if (name.length >= 2) scoreMap[name] = Math.max(scoreMap[name] || 0, parseInt(m[2]) || 0);
      }
      // Strategy 4: "**Name** — N/10" (final picks)
      for (const m of batchAnalysis.matchAll(/\*\*(.{1,60}?)\*\*\s*[—\-–]\s*(\d+)\s*\/\s*10/gi)) {
        const name = cleanName(m[1]);
        if (name.length >= 2 && name.length < 50 && !scoreMap[name]) {
          scoreMap[name] = parseInt(m[2]) || 0;
        }
      }
      // PASS detection
      for (const m of batchAnalysis.matchAll(/\*?\*?([^*—\n]+?)\*?\*?\s*—\s*PASS/gi)) {
        passSet.add(m[1].trim().replace(/🌐/g, '').toLowerCase());
      }

      console.log(`[AutoScan] Opus batch ${batchIdx + 1} done. Scores: ${Object.keys(scoreMap).length}`);
      
      // Stream top scores and fun verdicts to frontend
      const scoredEntries = Object.entries(scoreMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const scoreEmojis = { 10: '🏆', 9: '💎', 8: '🔥', 7: '⭐', 6: '👍', 5: '🤔', 4: '😬', 3: '👎', 2: '💤', 1: '🗑️' };
      for (const [name, score] of scoredEntries) {
        const emoji = scoreEmojis[Math.min(score, 10)] || '🤔';
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);
        safeWrite(`: ${emoji} ${displayName} — scored ${score}/10\n\n`);
      }
    } catch (e) {
      console.error(`[AutoScan] Opus batch ${batchIdx + 1} exception:`, e.message);
      allBatchAnalyses.push(`[Opus Batch ${batchIdx + 1} error: ${e.message}]`);
    }

    if (batchIdx + 1 < totalBatches) await sleep(1000);
  }

  // Build funnel summary for display
  const funnelSummary = `## SCAN SUMMARY\n` +
    `Total from Harmonic: ${savedSearchMeta?.totalBeforeDedup || 'n/a'}\n` +
    `Unique after dedup: ${savedSearchMeta?.totalAfterDedup || 'n/a'}\n` +
    `Fresh (not in DD/dismissed): ${savedSearchMeta?.freshCount || companyIds?.length || 'n/a'}\n` +
    `Enriched via GQL: ${fullCompanies?.length || 'n/a'}\n` +
    `After CRM dedup + filters: ${companyCards.length}\n` +
    `Sonnet passed: ${opusCandidates.length}/${companyCards.length} (${((opusCandidates.length / Math.max(companyCards.length, 1)) * 100).toFixed(0)}%)\n` +
    `Opus scored: ${Object.keys(scoreMap).length}\n`;

  const analysis = funnelSummary + '\n\n' + allBatchAnalyses.join('\n\n');

  console.log(`[AutoScan] ALL TIERS COMPLETE. Sonnet passed: ${opusCandidates.length}/${companyCards.length}. Opus scores: ${Object.keys(scoreMap).length}. Pass: ${passSet.size}`);

    // Fuzzy score lookup helper — strict matching to avoid false positives
    const getScore = (name) => {
      const n = (name || '').toLowerCase().trim();
      if (scoreMap[n]) return scoreMap[n];
      const noParen = n.replace(/\s*\(.*?\)\s*/g, '').trim();
      if (scoreMap[noParen]) return scoreMap[noParen];
      // Only match if name is 5+ chars AND one starts with the other (not just includes)
      if (noParen.length >= 5) {
        for (const [k, v] of Object.entries(scoreMap)) {
          if (k.length >= 5 && (k.startsWith(noParen) || noParen.startsWith(k))) return v;
        }
      }
      return 0;
    };

    // Attach scores to cards for downstream use
    companyCards.forEach(c => { 
      c._score = getScore(c.name);
      // HARD stealth penalty — cap score at 3 regardless of what Claude gave
      if (c._isStealth || (c.name || '').toLowerCase().startsWith('stealth company')) {
        const original = c._score;
        c._score = Math.min(c._score, 3);
        if (original > 3) {
          console.log(`[AutoScan] Stealth penalty: ${c.name} score ${original} → capped at ${c._score}`);
        }
      }
    });

    // Sort: scored companies first (high to low), then PASS companies, then rest
    companyCards.sort((a, b) => {
      if (a._score !== b._score) return b._score - a._score;
      const aPass = passSet.has((a.name||'').toLowerCase()) ? 1 : 0;
      const bPass = passSet.has((b.name||'').toLowerCase()) ? 1 : 0;
      if (aPass !== bPass) return bPass - aPass;
      return (b.funding_total || 0) - (a.funding_total || 0);
    });

    console.log(`[AutoScan] Final sort: ${Object.keys(scoreMap).length} scored, ${passSet.size} passed`);

    // Auto-push top picks to shared vetting pipeline
    // For savedSearch mode: batch1 (top 8 → DD), batch2 (overflow → stored)
    // For keyword mode: top 3 (daily) or top 5 (weekly) with score >= 7
    if (isSavedSearchMode) {
      // Try to match scores to company cards with fuzzy name matching
      const matchScore = (name) => {
        const n = (name || '').toLowerCase().trim();
        if (scoreMap[n]) return scoreMap[n];
        const noParen = n.replace(/\s*\(.*?\)\s*/g, '').trim();
        if (scoreMap[noParen]) return scoreMap[noParen];
        // Strict: 5+ chars and startsWith only
        if (noParen.length >= 5) {
          for (const [k, v] of Object.entries(scoreMap)) {
            if (k.length >= 5 && (k.startsWith(noParen) || noParen.startsWith(k))) return v;
          }
        }
        return 0;
      };

      const scored = companyCards
        .map(c => {
          let score = matchScore(c.name);
          // Hard stealth penalty — stealth companies never go to DD
          if ((c.name || '').toLowerCase().startsWith('stealth company') || c._isStealth) {
            score = Math.min(score, 3);
          }
          return { ...c, _score: score };
        })
        .filter(c => c._score >= 6)
        .filter(c => !(c.name || '').toLowerCase().startsWith('stealth company'))
        .filter(c => {
          // Smart exclude: actual investment vehicles, not companies in the finance industry
          // Must match BOTH a fund-like name pattern AND a fund-like description
          const n = (c.name || '').toLowerCase();
          const d = (c.description || '').toLowerCase().slice(0, 500);
          const fundNameSignals = /\b(fund|family office|vc firm|hedge fund)\b/i.test(n);
          const fundDescSignals = /\b(investment (fund|vehicle)|fund of funds|family office|hedge fund|venture capital firm|limited partners?|LP interests?|capital allocation|portfolio of (investments|companies)|invest in (startups|companies|funds)|manage[ds]? (assets|capital|investments)|AUM|assets under management)\b/i.test(d);
          // Only exclude if the company IS an investment vehicle, not just works in finance
          const isVehicle = (fundNameSignals && fundDescSignals) ||
            /\b(family office|hedge fund|venture capital firm|fund of funds)\b/i.test(d);
          if (isVehicle) console.log(`[AutoScan] EXCLUDED investment vehicle: ${c.name} — "${d.slice(0, 100)}"`);
          return !isVehicle;
        })
        .sort((a, b) => b._score - a._score);

      console.log(`[AutoScan] DD push: ${scored.length} companies scored ≥6 from ${companyCards.length} total`);
      console.log(`[AutoScan] Score map keys: ${Object.keys(scoreMap).join(', ')}`);
      console.log(`[AutoScan] Top scored: ${scored.slice(0, 10).map(c => `${c.name}=${c._score}`).join(', ')}`);

      const batch1 = scored.slice(0, 10);
      const batch2 = scored.slice(10, 30); // Overflow → stored

      // Push batch1 to vetting
      let vettingAdded = 0;
      if (batch1.length > 0) {
        try {
          // Extract per-company reasoning from Claude's analysis
          const reasoningMap = {};
          const reasoningMatches = analysis.matchAll(/\*\*([^*]+)\*\*[^]*?Score:\s*\d+\/10([\s\S]*?)(?=\*\*[^*]+\*\*|## |$)/gi);
          for (const m of reasoningMatches) {
            const name = m[1].trim().toLowerCase();
            const reasoning = m[2].trim().slice(0, 500); // Cap at 500 chars
            reasoningMap[name] = reasoning;
          }

          const vettingData = loadVetting();
          const existingNames = new Set(vettingData.companies.map(c => (c.name || '').toLowerCase()));
          for (const c of batch1) {
            if (!existingNames.has((c.name || '').toLowerCase())) {
              existingNames.add((c.name || '').toLowerCase());
              vettingData.companies.push({
                ...c,
                score: c._score,
                addedAt: Date.now(),
                source: `savedSearch-scan:${personId}`,
                sourceMeta: {
                  personId,
                  scanMode: 'savedSearch',
                  profileName: profile.name || 'Saved Search Scan',
                  scanDate: new Date().toISOString(),
                  sourceCategory: c._sourceCategory || null,
                },
                claudeReasoning: reasoningMap[(c.name || '').toLowerCase()] || null,
                fullAnalysis: analysis || null,
                votes: {},
                dismissed: false,
              });
              vettingAdded++;
            }
          }
          if (vettingAdded > 0) {
            saveVetting(vettingData);
            console.log(`[AutoScan] Batch1: pushed ${vettingAdded} to vetting pipeline`);
            // Mark DD additions as seen so they don't reappear
            try {
              const seenData = loadSeen();
              const existing = new Set(seenData[personId] || []);
              for (const c of batch1) {
                const cid = String(c.id || c.name);
                if (cid) existing.add(cid);
              }
              seenData[personId] = [...existing].slice(-5000);
              saveSeen(seenData);
            } catch (e) {}
          }
        } catch (e) { console.error('[AutoScan] Batch1 push error:', e.message); }
      }

      // Store batch2 for later promotion
      if (batch2.length > 0) {
        try {
          const batches = loadBatches();
          batches[personId] = batches[personId] || {};
          batches[personId].batch1 = batch1.map(c => ({ ...c, score: c._score }));
          batches[personId].batch2 = batch2.map(c => ({ ...c, score: c._score }));
          batches[personId].lastScanDate = new Date().toISOString().slice(0, 10);
          batches[personId].lastBatchPush = Date.now();
          saveBatches(batches);
          console.log(`[AutoScan] Batch2: stored ${batch2.length} overflow companies for ${personId}`);
        } catch (e) { console.error('[AutoScan] Batch2 store error:', e.message); }
      }

      console.log(`[AutoScan] SavedSearch summary: ${batch1.length} batch1, ${batch2.length} batch2, ${vettingAdded} pushed to DD`);
    } else {
      // Keyword mode: push top 5-10 with score >= 7
      const matchScoreKw = (name) => {
        const n = (name || '').toLowerCase().trim();
        if (scoreMap[n]) return scoreMap[n];
        const noParen = n.replace(/\s*\(.*?\)\s*/g, '').trim();
        if (scoreMap[noParen]) return scoreMap[noParen];
        if (noParen.length >= 5) {
          for (const [k, v] of Object.entries(scoreMap)) {
            if (k.length >= 5 && (k.startsWith(noParen) || noParen.startsWith(k))) return v;
          }
        }
        return 0;
      };

      const maxPicks = scanMode === 'weekly' ? 10 : 7;
      const topPicks = companyCards
        .filter(c => !(c.name || '').toLowerCase().startsWith('stealth company'))
        .filter(c => matchScoreKw(c.name) >= 7)
        .slice(0, maxPicks);
      console.log(`[AutoScan] Keyword DD push: ${topPicks.length} companies scored ≥7`);
      if (topPicks.length > 0) {
        try {
          // Extract per-company reasoning from Claude's analysis
          const reasoningMap = {};
          const reasoningMatches = analysis.matchAll(/\*\*([^*]+)\*\*[^]*?Score:\s*\d+\/10([\s\S]*?)(?=\*\*[^*]+\*\*|## |$)/gi);
          for (const m of reasoningMatches) {
            reasoningMap[m[1].trim().toLowerCase()] = m[2].trim().slice(0, 500);
          }

          const vettingData = loadVetting();
          const existingNames = new Set(vettingData.companies.map(c => (c.name || '').toLowerCase()));
          let vettingAdded = 0;
          for (const c of topPicks) {
            if (!existingNames.has((c.name || '').toLowerCase())) {
              existingNames.add((c.name || '').toLowerCase());
              vettingData.companies.push({
                ...c,
                score: scoreMap[(c.name || '').toLowerCase()] || 0,
                addedAt: Date.now(),
                source: `${scanMode}-scan:${personId}`,
                sourceMeta: {
                  personId,
                  scanMode: scanMode,
                  profileName: profile.name || 'Main Scan',
                  scanDate: new Date().toISOString(),
                },
                claudeReasoning: reasoningMap[(c.name || '').toLowerCase()] || null,
                fullAnalysis: analysis || null,
                votes: {},
                dismissed: false,
              });
              vettingAdded++;
            }
          }
          if (vettingAdded > 0) {
            saveVetting(vettingData);
            console.log(`[AutoScan] Pushed ${vettingAdded} top picks to vetting pipeline`);
          }
        } catch (e) { console.error('[AutoScan] Vetting push error:', e.message); }
      }
    }

    // Only mark companies ADDED TO DD as seen (not all scanned companies)
    // This way the same search re-ranks the full pool every time,
    // minus companies already in DD or manually dismissed (✕)

    // Merge remaining raw cards into results so ALL companies are browsable
    // Enriched/scored companies come first, then remaining raw cards sorted by funding
    let allResults = [...companyCards];
    if (isSavedSearchMode && allRawCards.length > 0) {
      const enrichedNames = new Set(companyCards.map(c => (c.name || '').toLowerCase().trim()));
      const remaining = allRawCards
        .filter(c => !enrichedNames.has((c.name || '').toLowerCase().trim()))
        .map(c => ({ ...c, _score: 0, _raw: true }));
      allResults = [...companyCards, ...remaining];
      console.log(`[AutoScan] Merged results: ${companyCards.length} enriched + ${remaining.length} raw = ${allResults.length} total`);
    }

    // Final backburn + per-user hide safety pass — covers anything that slipped past
    // the ID-based seenSet (e.g. matched by domain or normalized name only).
    const beforeBurnFinal = allResults.length;
    allResults = filterBackburn(allResults);
    allResults = filterUserHidden(allResults, _autoscanHideIdx);
    if (beforeBurnFinal !== allResults.length) {
      console.log(`[AutoScan/Filter] Final pass dropped ${beforeBurnFinal - allResults.length} results (backburn+user-hide)`);
    }

    return sendResult({
      results: allResults,
      analysis,
      queriesUsed: isSavedSearchMode ? profile.savedSearchIds.map(s => s.name) : queries,
      savedSearchMeta: savedSearchMeta || null,
      funnel: isSavedSearchMode ? {
        totalFromSearches: savedSearchMeta?.totalBeforeDedup || 0,
        afterDedup: savedSearchMeta?.totalAfterDedup || 0,
        fresh: savedSearchMeta?.freshCount || 0,
        enriched: fullCompanies.length,
        preFiltered: companyCards.length,
        sonnetPassed: opusCandidates.length,
        opusScored: Object.keys(scoreMap).length,
      } : {
        totalUrns: allUrns ? allUrns.size : 0,
        previouslyDismissed: allUrns ? allUrns.size - companyIds.length : 0,
        newCompanies: companyIds.length,
        detailsFetched: fullCompanies.length,
        preFiltered: companyCards.length,
        sonnetPassed: opusCandidates.length,
        opusScored: Object.keys(scoreMap).length,
      },
    });
  } catch (outerErr) {
    console.error('[AutoScan] Outer error:', outerErr.message);
    sendResult({ results: [], analysis: `Error: ${outerErr.message}`, funnel: {} });
  }
});

// ==========================================
// GITHUB SIGNAL ENDPOINT
// ==========================================
app.post('/api/signals/github', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Guarded keepalive — without this, writing to a closed socket after client
  // disconnect can crash the Node process (no global uncaughtException handler).
  let _ssConnected = true;
  const keepAlive = setInterval(() => {
    if (!_ssConnected) return;
    try { res.write(': keepalive\n\n'); } catch (e) { _ssConnected = false; clearInterval(keepAlive); }
  }, 5000);
  req.on('close', () => { _ssConnected = false; clearInterval(keepAlive); });
  const sendResult = (data) => {
    clearInterval(keepAlive);
    if (_ssConnected) {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
      try { res.end(); } catch (e) {}
    }
  };

  try {
    const ghToken = process.env.GITHUB_TOKEN;
    const anthropicKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;

    if (!ghToken) return sendResult({ error: 'GITHUB_TOKEN not set on server' });

    const { queries, filters } = req.body;
    const searchQueries = queries || [
      'indexer language:Rust stars:0..50 pushed:>2025-01-01',
      'sequencer language:Go stars:0..50 pushed:>2025-01-01',
      'relayer OR bridge language:TypeScript stars:0..50 pushed:>2025-01-01',
      'rpc provider language:Rust stars:0..50 pushed:>2025-01-01',
    ];

    const ghHeaders = {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github.v3+json',
    };

    // Search repos
    const allRepos = [];
    for (const q of searchQueries.slice(0, 5)) {
      try {
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=30`;
        const r = await fetch(url, { headers: ghHeaders });
        if (r.ok) {
          const data = await r.json();
          (data.items || []).forEach((repo) => {
            // Dedup by full_name
            if (!allRepos.find((r) => r.full_name === repo.full_name)) {
              allRepos.push(repo);
            }
          });
        }
        await sleep(200); // Rate limit courtesy
      } catch (e) {
        console.error('[GitHub] Query error:', e.message);
      }
    }

    console.log(`[GitHub] Found ${allRepos.length} repos`);

    // Build repo cards
    const repoCards = allRepos.map((r) => ({
      name: r.full_name,
      description: (r.description || '').slice(0, 200),
      url: r.html_url,
      homepage: r.homepage || null,
      stars: r.stargazers_count,
      forks: r.forks_count,
      language: r.language,
      pushed_at: r.pushed_at,
      created_at: r.created_at,
      open_issues: r.open_issues_count,
      owner: r.owner?.login,
      owner_avatar: r.owner?.avatar_url,
      owner_type: r.owner?.type,
      topics: (r.topics || []).slice(0, 8),
      default_branch: r.default_branch,
      license: r.license?.spdx_id,
    }));

    // Claude analysis
    if (anthropicKey && repoCards.length > 0) {
      const repoText = repoCards.map((r, i) =>
        `${i + 1}. ${r.name} (${r.language || '?'}) ⭐${r.stars} 🍴${r.forks}\n   ${r.description}\n   Topics: ${r.topics.join(', ') || 'none'}\n   Created: ${r.created_at?.slice(0, 10)} Last push: ${r.pushed_at?.slice(0, 10)}\n   Owner: ${r.owner} (${r.owner_type})`
      ).join('\n\n');

      const prompt = `You are a crypto/web3 infrastructure deal scout for Daxos Capital (Pre-Seed/Seed, $100K-$250K checks).

Analyze these ${repoCards.length} GitHub repositories. Look for:
- Teams building infrastructure (indexers, RPCs, bridges, oracles, sequencers, SDKs)
- Small teams (2-5 contributors) that look like early startups, not side projects
- Active development (recent pushes)
- No existing VC backing visible

BE STRICT WITH RATINGS. Most repos should be LOW. Only rate HIGH if the repo clearly looks like an early-stage startup building something investable — not tutorials, forks, personal projects, or large established projects. If none are relevant, rate them all LOW.

IMPORTANT: Start your response with a JSON block. For each repo, include signal level AND if you can identify a company/project name, include it. Format exactly like this:
\`\`\`json
{"1":{"signal":"HIGH","company":"ProjectName"},"2":{"signal":"LOW","company":null},"3":{"signal":"MEDIUM","company":"SomeProtocol"}}
\`\`\`

Then after the JSON, give your analysis. For each repo give a quick verdict:
🟢 HIGH SIGNAL — looks like an early-stage infra startup worth investigating
🟡 MEDIUM — could be interesting, needs more digging  
🔴 LOW — hobby project, too mature, or not relevant

Focus on the green and yellow repos. For HIGH repos, suggest what to investigate next.

REPOS:
${repoText}`;

      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        if (claudeRes.ok) {
          const data = await claudeRes.json();
          const analysis = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          
          // Parse signal ratings from Claude's JSON block (new format with company names)
          let signals = {};
          try {
            const jsonMatch = analysis.match(/```json\s*\n?([\s\S]*?)\n?```/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[1]);
              for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === 'string') {
                  signals[k] = { signal: v, company: null };
                } else {
                  signals[k] = { signal: v.signal || 'LOW', company: v.company || null };
                }
              }
            }
          } catch (e) { /* ignore parse errors */ }
          
          // Attach signal and company to each repo card
          const ratedRepos = repoCards.map((r, i) => ({
            ...r,
            signal: signals[String(i + 1)]?.signal || 'LOW',
            companyName: signals[String(i + 1)]?.company || null,
          }));
          
          // Sort: HIGH first, then MEDIUM, then LOW
          const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
          ratedRepos.sort((a, b) => { const d = (order[a.signal] || 2) - (order[b.signal] || 2); return d !== 0 ? d : (b.engagement || b.stars || 0) - (a.engagement || a.stars || 0); });
          
          // Harmonic enrichment for HIGH signal repos that have a company name
          const harmonicKey = process.env.HARMONIC_API_KEY;
          if (harmonicKey) {
            const highRepos = ratedRepos.filter((r) => r.signal === 'HIGH' && (r.companyName || r.owner));
            if (highRepos.length > 0) {
              console.log('[GitHub] Enriching ' + highRepos.length + ' HIGH repos with Harmonic...');
              const harmonicHeaders = { 'apikey': harmonicKey };
              for (const repo of highRepos.slice(0, 5)) {
                try {
                  const searchTerm = repo.companyName || repo.owner;
                  const searchUrl = `${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(searchTerm)}&size=3`;
                  const hRes = await fetch(searchUrl, { headers: harmonicHeaders });
                  if (hRes.ok) {
                    const hData = await hRes.json();
                    const urns = hData.results?.map((r) => r.entity_urn || r.urn).filter(Boolean) || [];
                    if (urns.length > 0) {
                      const companyId = urns[0].split(':').pop();
                      const detailRes = await fetch(`${HARMONIC_BASE}/companies/${companyId}`, { headers: harmonicHeaders });
                      if (detailRes.ok) {
                        const co = await detailRes.json();
                        repo.harmonic = {
                          name: co.name || co.company_name,
                          stage: co.stage || null,
                          sector: co.tags?.slice(0, 3) || [],
                          fundingTotal: co.funding?.funding_total || null,
                          lastRound: co.funding?.last_funding_type || null,
                          lastRoundDate: co.funding?.last_funding_at || null,
                          headcount: co.employee_count || null,
                          website: co.website?.url || co.domain || null,
                          linkedinUrl: co.socials?.linkedin?.url || null,
                        };
                        console.log('[GitHub] Harmonic hit: ' + searchTerm + ' -> ' + (repo.harmonic.name || '?') + ' (' + (repo.harmonic.fundingTotal ? '$' + (repo.harmonic.fundingTotal / 1e6).toFixed(1) + 'M' : 'no funding data') + ')');
                      }
                    }
                  }
                  await sleep(150);
                } catch (e) {
                  console.error('[GitHub] Harmonic enrichment error:', e.message);
                }
              }
            }
          }
          
          // Strip the JSON block from the analysis text
          const cleanAnalysis = analysis.replace(/```json\s*\n?[\s\S]*?\n?```\s*\n?/, '').trim();
          
          return sendResult({ repos: ratedRepos, analysis: cleanAnalysis, queriesUsed: searchQueries });
        }
      } catch (e) {
        console.error('[GitHub] Claude error:', e.message);
      }
    }

    return sendResult({ repos: repoCards.sort((a, b) => (b.stars || 0) - (a.stars || 0)), analysis: null, queriesUsed: searchQueries });
  } catch (err) {
    console.error('[GitHub] Error:', err.message);
    sendResult({ repos: [], analysis: null, error: err.message });
  }
});


// ==========================================

// ==========================================
// FARCASTER SIGNAL ENDPOINT (Neynar Paid)
// ==========================================
app.post('/api/signals/farcaster', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Guarded keepalive — without this, writing to a closed socket after client
  // disconnect can crash the Node process (no global uncaughtException handler).
  let _ssConnected = true;
  const keepAlive = setInterval(() => {
    if (!_ssConnected) return;
    try { res.write(': keepalive\n\n'); } catch (e) { _ssConnected = false; clearInterval(keepAlive); }
  }, 5000);
  req.on('close', () => { _ssConnected = false; clearInterval(keepAlive); });
  const sendResult = (data) => {
    clearInterval(keepAlive);
    if (_ssConnected) {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
      try { res.end(); } catch (e) {}
    }
  };

  try {
    const neynarKey = process.env.NEYNAR_API_KEY;
    const anthropicKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;

    if (!neynarKey) return sendResult({ error: 'NEYNAR_API_KEY not set on server' });

    const { channels, keywords, minFollowers, minEngagement } = req.body;

    const searchKeywords = keywords || [];
    const channelNames = channels || ['founders', 'base', 'ethereum', 'solana-dev'];

    const neynarHeaders = {
      'accept': 'application/json',
      'x-api-key': neynarKey,
    };

    const allCasts = [];

    // Search casts by keywords
    if (searchKeywords.length > 0) {
      for (const kw of searchKeywords.slice(0, 8)) {
        try {
          const url = `https://api.neynar.com/v2/farcaster/cast/search?q=${encodeURIComponent(kw)}&limit=100`;
          console.log('[Farcaster] Searching: "' + kw + '"');
          const r = await fetch(url, { headers: neynarHeaders });
          if (r.ok) {
            const data = await r.json();
            const casts = data.result?.casts || [];
            console.log('[Farcaster] "' + kw + '" -> ' + casts.length + ' casts');
            casts.forEach((cast) => {
              if (!allCasts.find((c) => c.hash === cast.hash)) {
                allCasts.push(cast);
              }
            });
          } else {
            const errText = await r.text().catch(() => '');
            console.error('[Farcaster] Search failed (' + r.status + '):', errText.slice(0, 200));
          }
          await sleep(200);
        } catch (e) {
          console.error('[Farcaster] Search error:', e.message);
        }
      }
    }

    // Fetch from channels
    for (const ch of channelNames.slice(0, 10)) {
      try {
        const url = `https://api.neynar.com/v2/farcaster/feed/channels?channel_ids=${encodeURIComponent(ch)}&limit=100&should_moderate=false`;
        console.log('[Farcaster] Channel: /' + ch);
        const r = await fetch(url, { headers: neynarHeaders });
        if (r.ok) {
          const data = await r.json();
          const casts = data.casts || [];
          console.log('[Farcaster] /' + ch + ' -> ' + casts.length + ' casts');
          casts.forEach((cast) => {
            if (!allCasts.find((c) => c.hash === cast.hash)) {
              allCasts.push(cast);
            }
          });
        } else {
          const errText = await r.text().catch(() => '');
          console.error('[Farcaster] Channel failed (' + r.status + '):', errText.slice(0, 200));
        }
        await sleep(200);
      } catch (e) {
        console.error('[Farcaster] Channel error:', e.message);
      }
    }

    console.log('[Farcaster] Found ' + allCasts.length + ' casts');

    // Build cast cards
    const castCards = allCasts.map((c) => ({
      hash: c.hash,
      text: (c.text || '').slice(0, 500),
      author: c.author?.display_name || c.author?.username || '?',
      username: c.author?.username || '?',
      pfp: c.author?.pfp_url || null,
      fid: c.author?.fid || 0,
      followers: c.author?.follower_count || 0,
      timestamp: c.timestamp,
      channel: c.channel?.id || null,
      likes: c.reactions?.likes_count || 0,
      recasts: c.reactions?.recasts_count || 0,
      replies: c.replies?.count || 0,
      embeds: (c.embeds || []).map((e) => e.url).filter(Boolean).slice(0, 3),
      warpcastUrl: c.author?.username ? ('https://warpcast.com/' + c.author.username + '/' + (c.hash || '').slice(0, 10)) : null,
    }));

    // Apply follower/engagement filters server-side
    const followerMin = minFollowers || 0;
    const engagementMin = minEngagement || 0;
    const totalRaw = castCards.length;
    const filteredCards = castCards.filter((c) =>
      c.followers >= followerMin && c.likes >= engagementMin
    );
    console.log('[Farcaster] After filters (followers>=' + followerMin + ', likes>=' + engagementMin + '): ' + filteredCards.length + '/' + totalRaw);

    // Cap at 60 for Claude analysis (sort by engagement first)
    const forClaude = [...filteredCards]
      .sort((a, b) => (b.likes + b.recasts) - (a.likes + a.recasts))
      .slice(0, 60);

    // Claude analysis
    if (anthropicKey && forClaude.length > 0) {
      const castText = forClaude.map((c, i) =>
        (i + 1) + '. @' + c.username + ' (' + c.followers + ' followers) ' + (c.channel ? 'in /' + c.channel : '') + '\n   "' + c.text.slice(0, 300) + '"\n   ' + c.likes + ' likes, ' + c.recasts + ' recasts, ' + c.replies + ' replies\n   ' + (c.embeds.length > 0 ? 'Links: ' + c.embeds.join(', ') : '')
      ).join('\n\n');

      const prompt = 'You are a crypto deal scout for Daxos Capital (Pre-Seed/Seed, $100K-$250K checks).\n\nAnalyze these ' + forClaude.length + ' Farcaster posts. You are looking for:\n- Founders announcing they are building something (especially infra, DeFi, consumer crypto, betting, gaming)\n- People looking for funding or mentioning pre-seed/seed rounds\n- Teams sharing early product launches, testnets, or demos\n- Interesting builders who might not have raised yet\n\nBE STRICT WITH RATINGS. Most posts should be LOW. Only rate HIGH if the post clearly involves a founder/builder announcing a specific product, raising a round, or launching something investable. Generic crypto commentary, memes, price discussion, or retweets are always LOW. If none of the posts are relevant, rate them all LOW — that is fine.\n\nIMPORTANT: Start your response with a JSON block. For each post, include signal level AND if you can identify a company/project name, include it. Format exactly like this:\n```json\n{"1":{"signal":"HIGH","company":"ProjectName"},"2":{"signal":"LOW","company":null},"3":{"signal":"MEDIUM","company":"SomeProtocol"}}\n```\n\nThen after the JSON, give your analysis. For each post give a quick verdict:\n🟢 HIGH SIGNAL - this person/team looks investable, worth reaching out\n🟡 MEDIUM - interesting but needs more context\n🔴 LOW - not relevant to deal flow\n\nFocus on the green and yellow posts. For high-signal ones, suggest next steps.\n\nPOSTS:\n' + castText;

      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        if (claudeRes.ok) {
          const data = await claudeRes.json();
          const analysis = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          
          // Parse signal ratings from Claude's JSON block (new format with company names)
          let signals = {};
          try {
            const jsonMatch = analysis.match(/```json\s*\n?([\s\S]*?)\n?```/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[1]);
              // Handle both old format {"1":"HIGH"} and new format {"1":{"signal":"HIGH","company":"X"}}
              for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === 'string') {
                  signals[k] = { signal: v, company: null };
                } else {
                  signals[k] = { signal: v.signal || 'LOW', company: v.company || null };
                }
              }
            }
          } catch (e) { /* ignore parse errors */ }
          
          // Attach signal and company to forClaude casts
          const ratedCasts = forClaude.map((c, i) => ({
            ...c,
            signal: signals[String(i + 1)]?.signal || 'LOW',
            companyName: signals[String(i + 1)]?.company || null,
          }));
          
          // Sort: HIGH first, then MEDIUM, then LOW
          const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
          ratedCasts.sort((a, b) => { const d = (order[a.signal] || 2) - (order[b.signal] || 2); return d !== 0 ? d : (b.likes + (b.recasts || 0)) - (a.likes + (a.recasts || 0)); });
          
          // Harmonic enrichment for HIGH signal posts that have a company name
          const harmonicKey = process.env.HARMONIC_API_KEY;
          if (harmonicKey) {
            const highCasts = ratedCasts.filter((c) => c.signal === 'HIGH' && c.companyName);
            if (highCasts.length > 0) {
              console.log('[Farcaster] Enriching ' + highCasts.length + ' HIGH posts with Harmonic...');
              const harmonicHeaders = { 'apikey': harmonicKey };
              for (const cast of highCasts.slice(0, 5)) {
                try {
                  const searchUrl = `${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(cast.companyName)}&size=3`;
                  const hRes = await fetch(searchUrl, { headers: harmonicHeaders });
                  if (hRes.ok) {
                    const hData = await hRes.json();
                    const urns = hData.results?.map((r) => r.entity_urn || r.urn).filter(Boolean) || [];
                    if (urns.length > 0) {
                      const companyId = urns[0].split(':').pop();
                      const detailRes = await fetch(`${HARMONIC_BASE}/companies/${companyId}`, { headers: harmonicHeaders });
                      if (detailRes.ok) {
                        const co = await detailRes.json();
                        cast.harmonic = {
                          name: co.name || co.company_name,
                          stage: co.stage || null,
                          sector: co.tags?.slice(0, 3) || [],
                          fundingTotal: co.funding?.funding_total || null,
                          lastRound: co.funding?.last_funding_type || null,
                          lastRoundDate: co.funding?.last_funding_at || null,
                          headcount: co.employee_count || null,
                          website: co.website?.url || co.domain || null,
                          linkedinUrl: co.socials?.linkedin?.url || null,
                        };
                        console.log('[Farcaster] Harmonic hit: ' + cast.companyName + ' -> ' + (cast.harmonic.name || '?') + ' (' + (cast.harmonic.fundingTotal ? '$' + (cast.harmonic.fundingTotal / 1e6).toFixed(1) + 'M' : 'no funding data') + ')');
                      }
                    }
                  }
                  await sleep(150);
                } catch (e) {
                  console.error('[Farcaster] Harmonic enrichment error:', e.message);
                }
              }
            }
          }
          
          // Strip the JSON block from the analysis text
          const cleanAnalysis = analysis.replace(/```json\s*\n?[\s\S]*?\n?```\s*\n?/, '').trim();
          
          return sendResult({ casts: ratedCasts, analysis: cleanAnalysis, channelsUsed: channelNames, totalRaw, afterFilter: filteredCards.length });
        }
      } catch (e) {
        console.error('[Farcaster] Claude error:', e.message);
      }
    }

    return sendResult({ casts: filteredCards.sort((a, b) => (b.likes + (b.recasts || 0)) - (a.likes + (a.recasts || 0))), analysis: null, channelsUsed: channelNames, totalRaw, afterFilter: filteredCards.length });
  } catch (err) {
    console.error('[Farcaster] Error:', err.message);
    sendResult({ casts: [], analysis: null, error: err.message });
  }
});

// ==========================================
// TWITTER/X SIGNAL ENDPOINT (Old Bird v2 via RapidAPI)
// ==========================================
app.post('/api/signals/twitter', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Guarded keepalive — without this, writing to a closed socket after client
  // disconnect can crash the Node process (no global uncaughtException handler).
  let _ssConnected = true;
  const keepAlive = setInterval(() => {
    if (!_ssConnected) return;
    try { res.write(': keepalive\n\n'); } catch (e) { _ssConnected = false; clearInterval(keepAlive); }
  }, 5000);
  req.on('close', () => { _ssConnected = false; clearInterval(keepAlive); });
  const sendResult = (data) => {
    clearInterval(keepAlive);
    if (_ssConnected) {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
      try { res.end(); } catch (e) {}
    }
  };

  try {
    const rapidApiKey = process.env.RAPIDAPI_KEY;
    const anthropicKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;

    if (!rapidApiKey) return sendResult({ error: 'RAPIDAPI_KEY not set on server. Sign up at rapidapi.com and subscribe to "The Old Bird V2".' });

    const { keywords, minLikes, minFollowers } = req.body;
    const searchKeywords = keywords || [];

    if (searchKeywords.length === 0) return sendResult({ error: 'No keywords provided' });

    const rapidHeaders = {
      'x-rapidapi-host': 'twitter-v24.p.rapidapi.com',
      'x-rapidapi-key': rapidApiKey,
    };

    const allTweets = [];
    const seenIds = new Set();

    // Search tweets by keywords
    for (const kw of searchKeywords.slice(0, 16)) {
      try {
        const url = `https://twitter-v24.p.rapidapi.com/search/?query=${encodeURIComponent(kw)}&section=latest&limit=50`;
        console.log('[Twitter] Searching: "' + kw + '"');
        const r = await fetch(url, { headers: rapidHeaders });
        if (r.ok) {
          const data = await r.json();
          // Log the top-level keys to understand response format
          console.log('[Twitter] "' + kw + '" response keys:', JSON.stringify(Object.keys(data || {})));
          if (data?.detail) console.log('[Twitter] "' + kw + '" detail:', JSON.stringify(data.detail).slice(0, 300));
          if (data?.data) console.log('[Twitter] data.data keys:', JSON.stringify(Object.keys(data.data)));
          
          // Old Bird returns Twitter's internal format — parse timeline entries
          // Try multiple possible paths
          let instructions = data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
          
          // Fallback: some versions nest differently
          if (instructions.length === 0) {
            instructions = data?.data?.search?.timeline_response?.timeline?.instructions || [];
          }
          if (instructions.length === 0 && data?.timeline) {
            instructions = data.timeline?.instructions || [];
          }
          if (instructions.length === 0 && data?.data?.timeline) {
            instructions = data.data.timeline?.instructions || [];
          }
          
          console.log('[Twitter] "' + kw + '" instructions count:', instructions.length);
          if (instructions.length > 0) {
            console.log('[Twitter] instruction types:', instructions.map(i => i.type || 'no-type').join(', '));
          }
          
          for (const instr of instructions) {
            const entries = instr.entries || [];
            console.log('[Twitter] "' + kw + '" entries in instruction:', entries.length);
            for (const entry of entries) {
              try {
                const result = entry?.content?.itemContent?.tweet_results?.result;
                if (!result || !result.legacy) continue;
                const tweet = result.legacy;
                const user = result.core?.user_results?.result?.legacy || {};
                const tweetId = result.rest_id || tweet.id_str;
                if (seenIds.has(tweetId)) continue;
                seenIds.add(tweetId);
                allTweets.push({
                  id: tweetId,
                  text: (tweet.full_text || '').slice(0, 500),
                  author: user.name || '?',
                  username: user.screen_name || '?',
                  pfp: (user.profile_image_url_https || '').replace('_normal', '_bigger'),
                  followers: user.followers_count || 0,
                  verified: user.verified || result.core?.user_results?.result?.is_blue_verified || false,
                  timestamp: tweet.created_at || null,
                  likes: tweet.favorite_count || 0,
                  retweets: tweet.retweet_count || 0,
                  replies: tweet.reply_count || 0,
                  quotes: tweet.quote_count || 0,
                  urls: (tweet.entities?.urls || []).map((u) => u.expanded_url).filter(Boolean).slice(0, 3),
                  tweetUrl: user.screen_name ? `https://x.com/${user.screen_name}/status/${tweetId}` : null,
                });
              } catch (e) { /* skip malformed entries */ }
            }
          }
          console.log('[Twitter] "' + kw + '" -> total ' + allTweets.length + ' tweets so far');
        } else {
          const errText = await r.text().catch(() => '');
          console.error('[Twitter] Search failed (' + r.status + '):', errText.slice(0, 200));
        }
        await sleep(300);
      } catch (e) {
        console.error('[Twitter] Search error:', e.message);
      }
    }

    console.log('[Twitter] Found ' + allTweets.length + ' tweets');

    // Apply filters
    const followerMin = minFollowers || 0;
    const likeMin = minLikes || 0;
    const totalRaw = allTweets.length;
    const filteredTweets = allTweets.filter((t) =>
      t.followers >= followerMin && t.likes >= likeMin
    );
    console.log('[Twitter] After filters: ' + filteredTweets.length + '/' + totalRaw);

    // Cap at 60 for Claude (sort by engagement)
    const forClaude = [...filteredTweets]
      .sort((a, b) => (b.likes + b.retweets + b.quotes) - (a.likes + a.retweets + a.quotes))
      .slice(0, 60);

    // Claude analysis
    if (anthropicKey && forClaude.length > 0) {
      const tweetText = forClaude.map((t, i) =>
        (i + 1) + '. @' + t.username + ' (' + t.followers.toLocaleString() + ' followers' + (t.verified ? ', verified' : '') + ')\n   "' + t.text.slice(0, 300) + '"\n   ' + t.likes + ' likes, ' + t.retweets + ' RTs, ' + t.replies + ' replies\n   ' + (t.urls.length > 0 ? 'Links: ' + t.urls.join(', ') : '')
      ).join('\n\n');

      const prompt = 'You are a crypto deal scout for Daxos Capital (Pre-Seed/Seed, $100K-$250K checks).\n\nAnalyze these ' + forClaude.length + ' tweets from X/Twitter. You are looking for:\n- Founders announcing they are building something (especially infra, DeFi, consumer crypto, betting, gaming)\n- People looking for funding or mentioning pre-seed/seed rounds\n- Teams sharing early product launches, testnets, or demos\n- Interesting builders who might not have raised yet\n\nBE STRICT WITH RATINGS. Most tweets should be LOW. Only rate HIGH if the tweet clearly involves a founder/builder announcing a specific product, raising a round, or launching something investable. Generic crypto commentary, memes, price discussion, shilling, or retweets are always LOW. If none are relevant, rate them all LOW.\n\nIMPORTANT: Start your response with a JSON block. For each tweet, include signal level AND company/project name if identifiable:\n```json\n{"1":{"signal":"HIGH","company":"ProjectName"},"2":{"signal":"LOW","company":null}}\n```\n\nThen give your analysis with verdicts:\n🟢 HIGH SIGNAL - investable, worth reaching out\n🟡 MEDIUM - interesting but needs more context\n🔴 LOW - not relevant to deal flow\n\nTWEETS:\n' + tweetText;

      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        if (claudeRes.ok) {
          const data = await claudeRes.json();
          const analysis = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

          let signals = {};
          try {
            const jsonMatch = analysis.match(/```json\s*\n?([\s\S]*?)\n?```/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[1]);
              for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === 'string') signals[k] = { signal: v, company: null };
                else signals[k] = { signal: v.signal || 'LOW', company: v.company || null };
              }
            }
          } catch (e) { console.error('[Twitter] JSON parse error:', e.message); }

          console.log('[Twitter] Signals parsed:', Object.keys(signals).length, 'of', forClaude.length);
          const signalCounts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
          for (const v of Object.values(signals)) signalCounts[v.signal || 'LOW']++;
          console.log('[Twitter] Signal breakdown:', JSON.stringify(signalCounts));

          const ratedTweets = forClaude.map((t, i) => ({
            ...t,
            signal: signals[String(i + 1)]?.signal || 'LOW',
            companyName: signals[String(i + 1)]?.company || null,
          }));

          const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
          ratedTweets.sort((a, b) => {
            const sigDiff = (order[a.signal] || 2) - (order[b.signal] || 2);
            if (sigDiff !== 0) return sigDiff;
            return (b.likes + b.retweets + b.quotes) - (a.likes + a.retweets + a.quotes);
          });

          // Harmonic enrichment for HIGH signal tweets
          const harmonicKey = process.env.HARMONIC_API_KEY;
          if (harmonicKey) {
            const highTweets = ratedTweets.filter((t) => t.signal === 'HIGH' && t.companyName);
            if (highTweets.length > 0) {
              console.log('[Twitter] Enriching ' + highTweets.length + ' HIGH tweets with Harmonic...');
              const harmonicHeaders = { 'apikey': harmonicKey };
              for (const tw of highTweets.slice(0, 5)) {
                try {
                  const searchUrl = `${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(tw.companyName)}&size=3`;
                  const hRes = await fetch(searchUrl, { headers: harmonicHeaders });
                  if (hRes.ok) {
                    const hData = await hRes.json();
                    const urns = hData.results?.map((r) => r.entity_urn || r.urn).filter(Boolean) || [];
                    if (urns.length > 0) {
                      const companyId = urns[0].split(':').pop();
                      const detailRes = await fetch(`${HARMONIC_BASE}/companies/${companyId}`, { headers: harmonicHeaders });
                      if (detailRes.ok) {
                        const co = await detailRes.json();
                        tw.harmonic = {
                          name: co.name || co.company_name,
                          stage: co.stage || null,
                          sector: co.tags?.slice(0, 3) || [],
                          fundingTotal: co.funding?.funding_total || null,
                          lastRound: co.funding?.last_funding_type || null,
                          lastRoundDate: co.funding?.last_funding_at || null,
                          headcount: co.employee_count || null,
                          website: co.website?.url || co.domain || null,
                        };
                        console.log('[Twitter] Harmonic: ' + tw.companyName + ' -> ' + (tw.harmonic.name || '?'));
                      }
                    }
                  }
                  await sleep(150);
                } catch (e) { console.error('[Twitter] Harmonic error:', e.message); }
              }
            }
          }

          const cleanAnalysis = analysis.replace(/```json\s*\n?[\s\S]*?\n?```\s*\n?/, '').trim();
          return sendResult({ tweets: ratedTweets, analysis: cleanAnalysis, totalRaw, afterFilter: filteredTweets.length });
        }
      } catch (e) {
        console.error('[Twitter] Claude error:', e.message);
      }
    }

    return sendResult({ tweets: filteredTweets.sort((a, b) => (b.likes + (b.retweets || 0)) - (a.likes + (a.retweets || 0))), analysis: null, totalRaw, afterFilter: filteredTweets.length });
  } catch (err) {
    console.error('[Twitter] Error:', err.message);
    sendResult({ tweets: [], analysis: null, error: err.message });
  }
});

// ==========================================
// SUPER SEARCH - UNIFIED MULTI-SOURCE SIGNAL AGGREGATOR
// ==========================================
// Super Search status tracking
if (!global._superSearchStatus) global._superSearchStatus = {};

// ───── PER-USER SCAN OWNERSHIP ─────
// Each Super Search is tagged with the requester's user id (from x-user-id header
// or body.userId). /status filters per-user when requested; cancel refuses
// cross-user destruction. Without this, Jake opening /super would auto-attach
// to Mark's in-flight scan (5 cascading bugs documented in May 25 audit).
const getUserId = (req) => {
  const src = (req.headers['x-user-id'] || '') ||
              (req.body && req.body.userId) ||
              (req.query && (req.query.userId || req.query.crm_user)) || '';
  return String(src).trim().toLowerCase();
};
// Back-compat: scans written before this deploy have no userId. During the
// grace window, treat them as "owned by everyone" so users don't lose access.
const SUPER_OWNER_GRACE_UNTIL = Date.now() + 24 * 60 * 60 * 1000;
const scanIsOwnedBy = (scan, userId) => {
  if (!scan) return false;
  if (!scan.userId) return Date.now() < SUPER_OWNER_GRACE_UNTIL;
  if (!userId) return false;
  return scan.userId === userId;
};

app.get('/api/signals/super/status', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const status = global._superSearchStatus || {};
  // Auto-clear stale scans >15 min
  const now = Date.now();
  for (const [k, v] of Object.entries(status)) {
    if (v.status === 'scanning' && v.startedAt && (now - v.startedAt) > 15 * 60 * 1000) {
      status[k] = { status: 'idle' };
    }
  }
  // Filtering: if request supplies userId/x-user-id, return only THAT user's scans
  // (personal recovery). Otherwise return ALL — used by ActiveScansPanel team view.
  const filterRequested = !!(req.headers['x-user-id'] || (req.query && (req.query.userId || req.query.crm_user)));
  if (filterRequested) {
    const userId = getUserId(req);
    const filtered = {};
    for (const [k, v] of Object.entries(status)) {
      if (scanIsOwnedBy(v, userId)) filtered[k] = v;
    }
    return res.json(filtered);
  }
  res.json(status);
});

app.post('/api/signals/super/cancel', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { scanId } = req.body || {};
  const userId = getUserId(req);
  const force = req.query && (req.query.force === 'true' || req.query.force === '1');
  if (!global._superSearchStatus) global._superSearchStatus = {};

  if (scanId && global._superSearchStatus[scanId]) {
    const scan = global._superSearchStatus[scanId];
    if (!force && !scanIsOwnedBy(scan, userId)) {
      console.log(`[Super] REFUSED cancel of ${scanId} — owner=${scan.userId || '(legacy)'} requester=${userId || '(anon)'}`);
      return res.status(403).json({
        success: false, error: 'forbidden',
        message: `Scan is owned by ${scan.userId || 'another user'} — refusing cross-user cancel. Pass ?force=true to override.`,
      });
    }
    scan.cancelled = true;
    saveSuperStateDebounced();
    console.log(`[Super] Scan ${scanId} cancelled by ${userId || 'anon'}${force ? ' (forced)' : ''}`);
    return res.json({ success: true, scanId, cancelled: true });
  }
  // No scanId — only cancel scans the requester owns (unless ?force=true)
  let count = 0;
  for (const [, v] of Object.entries(global._superSearchStatus)) {
    if (v.status !== 'scanning') continue;
    if (!force && !scanIsOwnedBy(v, userId)) continue;
    v.cancelled = true;
    count++;
  }
  saveSuperStateDebounced();
  res.json({ success: true, cancelledCount: count });
});

app.post('/api/signals/super/clear-status', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  global._superSearchStatus = {};
  res.json({ success: true });
});

// Reusable: assess how narrow/broad a super-search params payload is.
// Used by /preflight AND can be called mid-scan to warn on 0-result sources.
function assessQueryNarrowness({ sectors = [], customKeywords = '', baselines = [], portfolioCompanies = [], sources = [], additionalInfo = '' }) {
  const kwList = (customKeywords || '').split(',').map(k => k.trim()).filter(Boolean);
  const anchorCount = (baselines?.length || 0) + (portfolioCompanies?.length || 0);
  const sectorCount = sectors?.length || 0;
  const sourceCount = sources?.length || 0;
  const addlLen = (additionalInfo || '').trim().length;
  const breadth = (anchorCount * 2) + sectorCount + Math.min(kwList.length, 8) + Math.min(sourceCount, 4);
  let verdict = 'ok';
  const reasons = [];
  if (breadth <= 2) { verdict = 'too_narrow'; reasons.push('Very few inputs — pool will be tiny'); }
  else if (breadth >= 18) { verdict = 'too_broad'; reasons.push('Many inputs — pool may dilute signal'); }
  const aiExpansionWillRun = (anchorCount > 0) || (sectorCount > 0 && (kwList.length > 0 || addlLen > 100));
  return { breadth, verdict, reasons, aiExpansionWillRun, kwCount: kwList.length, anchorCount, sectorCount };
}

// ==========================================
// SUPER SEARCH — PREFLIGHT (cheap pre-check ≤5s)
// Returns warnings, expected sources, query-quality assessment, cost estimate.
// User's frontend calls this BEFORE the cost-confirm modal so users can fix
// narrow/broken queries before paying for a real scan that returns nothing.
// ==========================================
app.post('/api/signals/super/preflight', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const t0 = Date.now();
  try {
    let {
      sectors = [], chains = [], sources = ['twitter', 'farcaster', 'github', 'harmonic'],
      customKeywords = '', additionalInfo = '',
      baselines = [], portfolioCompanies = [],
      includeCRM = false, crmStages = [],
      superTier = 'sonnet', suggestKeywords = false,
    } = req.body || {};
    if (!Array.isArray(sectors)) sectors = [];
    if (!Array.isArray(sources)) sources = [];
    if (!Array.isArray(baselines)) baselines = [];
    if (!Array.isArray(portfolioCompanies)) portfolioCompanies = [];
    if (!Array.isArray(crmStages)) crmStages = [];
    if (typeof customKeywords !== 'string') customKeywords = '';
    if (typeof additionalInfo !== 'string') additionalInfo = '';
    if (typeof superTier !== 'string') superTier = 'sonnet';

    const warnings = [];
    const sourcesLikelyToFire = [];
    const sourcesLikelyEmpty = [];

    const hasAnchors = baselines.length > 0 || (includeCRM && crmStages.length > 0) || portfolioCompanies.length > 0;
    if (sectors.length === 0 && !customKeywords.trim() && !hasAnchors) {
      warnings.push({ severity: 'error', message: 'No search inputs. Pick a sector, add keywords, or attach a baseline anchor.', fix: 'Add at least one of: sector, customKeywords, or baselines[]' });
    }

    const envChecks = {
      twitter: !!process.env.RAPIDAPI_KEY,
      farcaster: !!process.env.NEYNAR_API_KEY,
      github: true,
      harmonic: !!process.env.HARMONIC_API_KEY,
      producthunt: !!(process.env.PH_TOKEN || (process.env.PH_API_KEY && process.env.PH_API_SECRET)),
    };
    for (const s of sources) {
      if (envChecks[s]) sourcesLikelyToFire.push(s);
      else sourcesLikelyEmpty.push({ source: s, reason: `${s} API key not set on server` });
    }
    if (sourcesLikelyToFire.length === 0) {
      warnings.push({ severity: 'error', message: 'No selected sources have API keys configured.', fix: 'Pick a source whose key is set (most reliably: harmonic, github).' });
    }

    // Anchor validation — parallel, capped at 8, ≤1s each typically
    const harmonicKey = process.env.HARMONIC_API_KEY;
    const anchorChecks = [];
    if (harmonicKey && (baselines.length > 0 || portfolioCompanies.length > 0)) {
      const allAnchors = [
        ...baselines.map(b => ({ ...b, _type: 'baseline' })),
        ...portfolioCompanies.map(p => ({ ...p, _type: 'portfolio' })),
      ].slice(0, 8);
      const hdrs = { apikey: harmonicKey };
      const checkOne = async (a) => {
        if (!a.id) return { name: a.name, type: a._type, ok: false, reason: 'no_id', similarCount: 0 };
        try {
          const r = await fetch(`${HARMONIC_BASE}/search/similar_companies/${a.id}?size=1`, { headers: hdrs });
          if (r.status === 404) return { name: a.name, type: a._type, ok: false, reason: 'stale_id', similarCount: 0 };
          if (!r.ok) return { name: a.name, type: a._type, ok: false, reason: `http_${r.status}`, similarCount: 0 };
          const data = await r.json();
          const raw = Array.isArray(data) ? data : (data.results || data.similar_companies || data.companies || []);
          return { name: a.name, type: a._type, ok: true, reason: 'ok', similarCount: raw.length };
        } catch (e) {
          return { name: a.name, type: a._type, ok: false, reason: 'fetch_err', similarCount: 0 };
        }
      };
      const results = await Promise.allSettled(allAnchors.map(checkOne));
      results.forEach(r => anchorChecks.push(r.status === 'fulfilled' ? r.value : { ok: false, reason: 'promise_rejected' }));
      for (const c of anchorChecks) {
        if (!c.ok && c.reason === 'stale_id') warnings.push({ severity: 'error', message: `Stale anchor: "${c.name}" — Harmonic returned 404.`, fix: `Remove "${c.name}" and re-add from latest Harmonic search.` });
        else if (!c.ok && c.reason === 'no_id') warnings.push({ severity: 'warn', message: `Anchor "${c.name}" has no Harmonic id — can't verify.`, fix: 'Re-select from search results so the id attaches.' });
        else if (!c.ok) warnings.push({ severity: 'warn', message: `Anchor "${c.name}" check failed (${c.reason}).`, fix: 'Harmonic may be transient — retry in 30s.' });
        else if (c.similarCount === 0) warnings.push({ severity: 'warn', message: `Anchor "${c.name}" has 0 similar companies in Harmonic.`, fix: 'Pick a better-known anchor — this one won\'t contribute candidates.' });
      }
    } else if (!harmonicKey && (baselines.length > 0 || portfolioCompanies.length > 0)) {
      warnings.push({ severity: 'error', message: 'Anchors provided but HARMONIC_API_KEY is not set.', fix: 'Set the env var on Railway, or remove anchors.' });
    }

    const assessment = assessQueryNarrowness({ sectors, customKeywords, baselines, portfolioCompanies, sources, additionalInfo });
    const tierWantsAIExpansion = ['opus80', 'extreme'].includes(superTier);
    if (tierWantsAIExpansion && !assessment.aiExpansionWillRun) {
      warnings.push({ severity: 'high', message: 'AI Query Expansion will skip — needs anchors OR (sectors + keywords/additionalInfo >100 chars).', fix: 'Add a baseline anchor, or write more in additionalInfo.' });
    }
    if (assessment.verdict === 'too_broad') warnings.push({ severity: 'low', message: `Query is broad (breadth=${assessment.breadth}). Signal-to-noise may suffer.`, fix: 'Consider tightening — drop one sector or trim keywords.' });
    // narrow-query warning is folded into the signal-count thresholds below

    // ── BETTER signal-count formula (per Agent 1 spec) ──
    const kwList = customKeywords.split(',').map(s => s.trim()).filter(Boolean);
    const YIELD = { twitter: 25, farcaster: 12, github: 8, producthunt: 3, harmonic: 15 };
    const TIER_HARMONIC_MULT = { haiku: 1, sonnet: 1, opus20: 1.5, opus80: 3, extreme: 10 };
    const SECTOR_BREADTH_MULT = 1 + Math.min(sectors.length, 4) * 0.25;
    const anchorCount = baselines.length + portfolioCompanies.length;
    const effectiveKw = Math.max(1, Math.min(kwList.length + sectors.length * 2, 16));
    let estimatedSignals = 0;
    for (const s of sourcesLikelyToFire) {
      const base = (YIELD[s] || 5) * effectiveKw * SECTOR_BREADTH_MULT;
      if (s === 'harmonic') estimatedSignals += base * (TIER_HARMONIC_MULT[superTier] || 1) + anchorCount * 50;
      else estimatedSignals += base;
    }
    if (tierWantsAIExpansion && assessment.aiExpansionWillRun) {
      estimatedSignals += superTier === 'extreme' ? (50 * 250) : (20 * 150);
    }
    // 25% dedup haircut across sources
    estimatedSignals = Math.round(estimatedSignals * 0.75);

    // ── SIGNAL-COUNT severity thresholds (the headline metric) ──
    if (estimatedSignals < 50) {
      warnings.push({ severity: 'critical', message: `Expected pool: only ~${estimatedSignals} signals. Almost certainly too thin for AI to rank meaningfully.`, fix: 'Add a sector, broaden keywords, or attach an anchor.' });
    } else if (estimatedSignals < 200) {
      warnings.push({ severity: 'high', message: `Expected pool: ~${estimatedSignals} signals. Small — results may be sparse.`, fix: 'Add another keyword or sector to widen.' });
    } else if (estimatedSignals < 500) {
      warnings.push({ severity: 'medium', message: `Expected pool: ~${estimatedSignals} signals — modest. AI will have a decent set to rank.`, fix: 'Optional: add one more sector or keyword for richer results.' });
    } else if (estimatedSignals < 1000) {
      warnings.push({ severity: 'low', message: `Expected pool: ~${estimatedSignals} signals — healthy.`, fix: null });
    }

    const opusTopN = { opus20: 20, opus80: 80, extreme: 300 }[superTier] || 0;
    const screenCost = Math.min(estimatedSignals, 500) * (superTier === 'haiku' ? 0.0005 : 0.002);
    const opusCost = opusTopN * 0.015;
    const queryGenCost = tierWantsAIExpansion ? 0.05 : 0;
    const estimatedCostUsd = +(queryGenCost + screenCost + opusCost).toFixed(2);

    // ── EDGE-CASE CHECKS (Agent 3 spec) ──
    // Tier-vs-breadth mismatches
    if (['opus80', 'extreme'].includes(superTier) && assessment.breadth <= 2) {
      warnings.push({ severity: 'high', message: `Tier "${superTier}" on a very narrow query (breadth=${assessment.breadth}) wastes $15-18 on Opus scoring of low-relevance noise.`, fix: 'Drop to opus20, or add anchors/sectors first.' });
    }
    if (superTier === 'haiku' && assessment.breadth >= 18) {
      warnings.push({ severity: 'medium', message: `Haiku tier on a broad query (breadth=${assessment.breadth}) under-screens — true positives may be missed.`, fix: 'Promote to sonnet, or tighten the query first.' });
    }
    // additionalInfo bloat
    if (additionalInfo.length > 4000) {
      const extraTokens = Math.round(additionalInfo.length / 4);
      const batches = ['opus80', 'extreme'].includes(superTier) ? 50 : 20;
      const bloatCost = +((extraTokens * batches * 3) / 1e6).toFixed(2);
      warnings.push({ severity: 'medium', message: `additionalInfo is ${additionalInfo.length} chars (~${extraTokens} tokens × ~${batches} batches) → ~$${bloatCost} extra in token bloat.`, fix: 'Trim to <2000 chars — keep only the key thesis facts.' });
    }
    // Funding-filter exclusion on capital-heavy sectors
    const fundingFilter = (req.body.fundingFilter || 'auto');
    const heavyRaiseSectors = ['defense', 'aerospace', 'biotech', 'climate', 'energy', 'hardware', 'robotics', 'semiconductors', 'space'];
    if (fundingFilter === 'under_2m' && sectors.some(s => heavyRaiseSectors.some(h => String(s).toLowerCase().includes(h)))) {
      warnings.push({ severity: 'medium', message: 'under_2m funding filter on capital-heavy sectors (defense/aerospace/biotech/etc) will exclude most real targets — typical raises are $3-15M.', fix: 'Switch to under_10m or all.' });
    }
    // Time range too short
    const timeRange = (req.body.timeRange || 'week');
    if (timeRange === 'day' && (sources.includes('twitter') || sources.includes('farcaster'))) {
      warnings.push({ severity: 'medium', message: '24h window on social sources usually yields <5 signals — most account activity is older.', fix: 'Use week or month.' });
    }
    // Engagement filters too restrictive
    const minFollowers = Number(req.body.minFollowers || 0);
    const minEngagement = Number(req.body.minEngagement || 0);
    if (minFollowers > 10000 || minEngagement > 500) {
      warnings.push({ severity: 'medium', message: `Engagement thresholds (followers ≥ ${minFollowers}, engagement ≥ ${minEngagement}) will eliminate ~95% of early-stage accounts.`, fix: 'Drop to 0 for early-stage discovery.' });
    }
    // Stuck in-flight scan from prior session
    try {
      const stuck = Object.entries(global._superSearchStatus || {}).filter(([, v]) =>
        v.status === 'scanning' && v.startedAt && (Date.now() - v.startedAt) < 30 * 60_000 && !v.cancelled
      );
      if (stuck.length > 0) {
        const ids = stuck.map(([k]) => k).slice(0, 3).join(', ');
        warnings.push({ severity: 'high', message: `${stuck.length} scan(s) still in flight from prior session: ${ids}. Starting a new one competes for budget/rate-limits.`, fix: `Cancel them first: POST /api/signals/super/cancel { scanId: "${stuck[0][0]}" }` });
      }
    } catch (e) {}
    // GitHub source with non-code keywords
    const codeShaped = /\b(sdk|api|cli|framework|library|repo|github|open[- ]?source|protocol|server|client|compiler|kernel)\b/i;
    if (sources.includes('github') && kwList.length > 0 && !codeShaped.test(customKeywords)) {
      warnings.push({ severity: 'low', message: "GitHub source returns repos — your keywords don't look code-shaped. Expect ~0 hits from GitHub.", fix: 'Drop GitHub, or add code-shaped keywords (sdk, framework, protocol, ...).' });
    }
    // Crypto-sector vs non-crypto keyword drift
    const cryptoSectorPattern = /\b(defi|web3|crypto|chain|nft|dao|stable|token|wallet|bridge)\b/i;
    const cryptoVocab = /\b(defi|web3|crypto|chain|token|nft|dao|l1|l2|rollup|solana|eth|bitcoin|wallet)\b/i;
    const hasCryptoSector = sectors.some(s => cryptoSectorPattern.test(String(s)));
    const kwHasCrypto = cryptoVocab.test(customKeywords + ' ' + additionalInfo);
    if (hasCryptoSector && kwList.length > 0 && !kwHasCrypto) {
      warnings.push({ severity: 'low', message: "Crypto-heavy sectors + non-crypto keywords — sector keyword expansion will drift toward crypto vocab that doesn't match yours.", fix: 'Remove crypto sectors, or add crypto vocab to keywords.' });
    }

    // ── AUTO-WIDEN consent detection ──
    // Same condition the scan itself uses: narrow + Harmonic-selected + Anthropic available
    const harmonicSelected = sources.includes('harmonic');
    const anthropicAvail = (req.headers['x-anthropic-key'] || '').trim().startsWith('sk-') || !!process.env.ANTHROPIC_API_KEY;
    const widenLikely = harmonicSelected && anthropicAvail && (
      (kwList.length <= 2 && anchorCount === 0) ||
      assessment.verdict === 'too_narrow' ||
      estimatedSignals < 300
    );
    let autoWidenSuggested = false, autoWidenEstCost = 0, autoWidenExplanation = '';
    if (widenLikely) {
      autoWidenSuggested = true;
      autoWidenEstCost = 0.001;
      const narrowList = kwList.length ? kwList.join(', ') : (sectors[0] || 'your query');
      autoWidenExplanation = `Your narrow query ("${narrowList}") is likely to return <10 Harmonic companies. Haiku can expand to 5 broader synonyms — adds ~$0.001 and ~10s.`;
    }

    // Optional Haiku keyword expansion (frontend opts in via suggestKeywords:true)
    let suggestedKeywords = null;
    if (suggestKeywords && (kwList.length > 0 || sectors.length > 0)) {
      const anthropicKey = (req.headers['x-anthropic-key'] || '').trim().startsWith('sk-')
        ? req.headers['x-anthropic-key'].trim() : process.env.ANTHROPIC_API_KEY;
      if (anthropicKey) {
        try {
          const prompt = `Suggest 6 broader synonyms / adjacent search terms for these inputs (early-stage startup search). Return JSON only.\n\nSectors: ${sectors.join(', ') || 'none'}\nCurrent keywords: ${kwList.join(', ') || 'none'}\nContext: ${additionalInfo.slice(0, 400) || 'none'}\n\nJSON: {"keywords": ["term1", "term2", ...]}`;
          const ctrl = new AbortController();
          const timeout = setTimeout(() => ctrl.abort(), 3500);
          const hr = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
            signal: ctrl.signal,
          });
          clearTimeout(timeout);
          if (hr.ok) {
            const hd = await hr.json();
            const txt = hd.content.filter(b => b.type === 'text').map(b => b.text).join('');
            const m = txt.match(/\{[\s\S]*?"keywords"[\s\S]*?\}/);
            if (m) suggestedKeywords = (JSON.parse(m[0]).keywords || []).filter(k => typeof k === 'string').slice(0, 8);
          }
        } catch (e) { console.error('[Preflight] keyword expansion failed:', e.message); }
      }
    }

    // Sort warnings by severity (critical → high → medium → low → info) so the
    // frontend renders the worst thing first without re-sorting.
    const SEV_RANK = { critical: 0, high: 1, error: 1, medium: 2, warn: 2, low: 3, info: 4 };
    warnings.sort((a, b) => (SEV_RANK[a.severity] ?? 99) - (SEV_RANK[b.severity] ?? 99));

    const elapsed = Date.now() - t0;
    console.log(`[Preflight] ${elapsed}ms — warnings:${warnings.length} estSignals:${estimatedSignals} cost:$${estimatedCostUsd} widen:${autoWidenSuggested}`);
    res.json({
      ok: !warnings.some(w => w.severity === 'critical' || w.severity === 'error'),
      warnings,
      expected: {
        estimatedSignals,
        sourcesLikelyToFire,
        sourcesLikelyEmpty,
        firingSources: sourcesLikelyToFire,        // alias for new frontend
        emptySources: sourcesLikelyEmpty.map(e => `${e.source} (${e.reason})`),
        queryAssessment: assessment.verdict,
        suggestedKeywords,
        estimatedCostUsd,
        autoWidenSuggested,
        autoWidenEstCost,
        autoWidenExplanation,
      },
      _meta: { elapsedMs: elapsed, anchorChecks, breadth: assessment.breadth, tier: superTier },
    });
  } catch (e) {
    console.error('[Preflight] FAILED:', e.message);
    res.status(500).json({ ok: false, warnings: [{ severity: 'error', message: 'Preflight failed: ' + e.message }], expected: null });
  }
});

app.post('/api/signals/super', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const scanId = (req.body && req.body.scanId) || ('super_' + Date.now());
  // Track client connection — scan continues server-side even if client drops
  let clientConnected = true;
  req.on('close', () => { clientConnected = false; clearInterval(keepAlive); });
  // Guarded write — swallows ERR_STREAM_WRITE_AFTER_END after client disconnects
  const safeWrite = (data) => { if (!clientConnected) return; try { res.write(data); } catch (e) { clientConnected = false; } };
  const keepAlive = setInterval(() => { safeWrite(': keepalive\n\n'); }, 5000);
  // Helper: check if this scan was cancelled (called between expensive operations)
  const isCancelled = () => !!(global._superSearchStatus?.[scanId]?.cancelled);
  const sendProgress = (msg, stage, meta) => {
    safeWrite(`data: ${JSON.stringify({ progress: msg, stage: stage || null, meta: meta || null })}\n\n`);
    // Also update global status for reconnection
    if (!global._superSearchStatus) global._superSearchStatus = {};
    const prev = global._superSearchStatus[scanId] || {};
    global._superSearchStatus[scanId] = { ...prev, status: 'scanning', progress: msg, stage: stage || prev.stage || null, startedAt: prev.startedAt || Date.now() };
    saveSuperStateDebounced();
  };
  const sendResult = (data) => {
    clearInterval(keepAlive);
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
    try { res.end(); } catch (e) {}
    // Store results in global status for reconnection (and persist to disk)
    if (!global._superSearchStatus) global._superSearchStatus = {};
    const prev = global._superSearchStatus[scanId] || {};
    global._superSearchStatus[scanId] = { ...prev, status: data.cancelled ? 'cancelled' : 'done', finishedAt: Date.now(), results: data };
    // TERMINAL transition — write to disk synchronously. The 2s debounce was
    // losing scans whose completion happened to land inside a Railway redeploy
    // window (the user's 25-May scan was destroyed exactly this way).
    saveSuperStateNow();
  };
  const startTime = Date.now();
  if (!global._superSearchStatus) global._superSearchStatus = {};
  // Persist tier so recovery on page reload can restore ETA + cost display correctly.
  // Without this, frontend's superTier resets to its useState default ('opus20') and the
  // ETA calculation uses the wrong tier ceiling → "0 min remaining" forever for any
  // scan whose elapsed > 5 min. Read directly from req.body since destructure hasn't run yet.
  const _initialTier = (req.body && typeof req.body.superTier === 'string') ? req.body.superTier : 'sonnet';
  const _ownerId = getUserId(req);  // '' if anonymous
  // ScanId collision protection — refuse if a different user already owns this scanId.
  const _existing = global._superSearchStatus[scanId];
  if (_existing && _existing.userId && _ownerId && _existing.userId !== _ownerId) {
    return res.status(409).json({ error: `scanId collision with user ${_existing.userId} — retry with a new scanId` });
  }
  global._superSearchStatus[scanId] = { status: 'scanning', progress: 'Initializing...', stage: 'import', startedAt: startTime, cancelled: false, tier: _initialTier, userId: _ownerId };
  console.log(`[Super] Scan ${scanId} started by ${_ownerId || 'anon'} tier=${_initialTier}`);
  saveSuperStateDebounced();
  // Send scanId to frontend immediately so Cancel can target this scan
  res.write(`data: ${JSON.stringify({ scanId })}\n\n`);

  try {
    const _hdrKey = (req.headers['x-anthropic-key'] || '').trim();
    const anthropicKey = (_hdrKey.startsWith('sk-') ? _hdrKey : '') || process.env.ANTHROPIC_API_KEY;
    const harmonicKey = process.env.HARMONIC_API_KEY;
    const neynarKey = process.env.NEYNAR_API_KEY;
    const rapidApiKey = process.env.RAPIDAPI_KEY;

    console.log('[Super] Anthropic key source:', _hdrKey.startsWith('sk-') ? 'header' : 'env', '| key starts:', (anthropicKey || '').slice(0, 8) + '...');

    let {
      sectors = [],
      chains = [],
      sources = ['twitter', 'farcaster', 'github', 'harmonic'],
      minFollowers = 0,
      minEngagement = 0,
      timeRange = 'week',
      stage = [],
      customKeywords = '',
      superTier = 'sonnet', // haiku|sonnet|opus20|opus80|extreme
      // Anchors (Deep Search integration)
      baselines = [],
      baselineImportance = 70,    // 0-100
      includeCRM = false,
      crmStages = [],
      crmImportance = 50,         // 0-100
      portfolioCompanies = [],
      portfolioImportance = 50,   // 0-100
      additionalInfo = '',        // freeform extra context
      fundingFilter = 'auto',     // 'under_2m' | 'under_10m' | 'under_25m' | 'all' | 'auto'
      optedIntoWiden = null,      // null = legacy auto-on, true = explicit on, false = opt-out
    } = req.body;
    // Defensive coercion — destructure defaults only apply for `undefined`, not for `null` or
    // wrong-shaped values (object/string). Stale localStorage saved-searches or partial
    // payloads have been observed sending these as null → crash on spread/.includes/.length.
    if (!Array.isArray(sectors)) sectors = [];
    if (!Array.isArray(chains)) chains = [];
    if (!Array.isArray(sources) || sources.length === 0) sources = ['twitter', 'farcaster', 'github', 'harmonic'];
    if (!Array.isArray(stage)) stage = [];
    if (!Array.isArray(baselines)) baselines = [];
    if (!Array.isArray(crmStages)) crmStages = [];
    if (!Array.isArray(portfolioCompanies)) portfolioCompanies = [];
    // String fields — destructure defaults also don't trigger on null, so a stale payload
    // sending customKeywords: null hits `null.trim()` → crash with SSE error "Cannot read
    // properties of null (reading 'trim')". This is why Super Search "silently fails".
    if (typeof customKeywords !== 'string') customKeywords = '';
    if (typeof additionalInfo !== 'string') additionalInfo = '';
    if (typeof superTier !== 'string') superTier = 'sonnet';
    if (typeof timeRange !== 'string') timeRange = 'week';
    if (typeof fundingFilter !== 'string') fundingFilter = 'auto';
    // Auto: under_10m when any anchor present, else 'all'
    const effectiveFundingFilter = fundingFilter === 'auto'
      ? (baselines.length > 0 || portfolioCompanies.length > 0 ? 'under_10m' : 'all')
      : fundingFilter;
    const fundingCap = { under_2m: 2_000_000, under_10m: 10_000_000, under_25m: 25_000_000, all: Infinity }[effectiveFundingFilter] || Infinity;
    // Merit-mode triggers full 5-dim rating + anchor sanity check. Active when baselines present.
    const meritMode = baselines.length > 0;
    const useOpus = ['opus20', 'opus80', 'extreme'].includes(superTier);
    // Extreme rates 300 — big pool from multi-hop deserves deep coverage
    const opusTopN = { opus20: 20, opus80: 80, extreme: 300 }[superTier] || 0;
    const useHaikuScreen = superTier === 'haiku';
    const screenModel = useHaikuScreen ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514';
    // For Max/Extreme tiers, guarantee Opus runs by falling back to top-N by engagement
    // when not enough HIGH/MEDIUM signals exist. Users paid for deep scoring — give it to them.
    const opusFillToN = ['opus80', 'extreme'].includes(superTier);

    // ── Real token-based cost tracking ──
    // Anthropic pricing (per 1M tokens): Haiku 4.5 $1/$5 · Sonnet 4 $3/$15 · Opus 4.6 $15/$75
    const PRICING = {
      'claude-haiku-4-5-20251001':  { in: 1,  out: 5  },
      'claude-sonnet-4-20250514':   { in: 3,  out: 15 },
      'claude-opus-4-6':            { in: 15, out: 75 },
    };
    const usage = { sonnetIn: 0, sonnetOut: 0, opusIn: 0, opusOut: 0, haikuIn: 0, haikuOut: 0 };
    const recordUsage = (model, u) => {
      if (!u) return;
      const inT = u.input_tokens || 0, outT = u.output_tokens || 0;
      if (model.includes('haiku'))      { usage.haikuIn += inT; usage.haikuOut += outT; }
      else if (model.includes('opus'))  { usage.opusIn  += inT; usage.opusOut  += outT; }
      else                              { usage.sonnetIn += inT; usage.sonnetOut += outT; }
    };
    const computeCost = () => {
      const sonnet = (usage.sonnetIn * PRICING['claude-sonnet-4-20250514'].in + usage.sonnetOut * PRICING['claude-sonnet-4-20250514'].out) / 1e6;
      const opus   = (usage.opusIn   * PRICING['claude-opus-4-6'].in           + usage.opusOut   * PRICING['claude-opus-4-6'].out)           / 1e6;
      const haiku  = (usage.haikuIn  * PRICING['claude-haiku-4-5-20251001'].in + usage.haikuOut  * PRICING['claude-haiku-4-5-20251001'].out) / 1e6;
      return { total: sonnet + opus + haiku, sonnet, opus, haiku, usage };
    };

    // Track which sources actually ran (vs requested but skipped due to missing env keys)
    const sourcesRequested = [...sources];
    const sourcesActual = [];
    const sourcesSkipped = []; // [{source, reason}]
    const hasAnchors = baselines.length > 0 || (includeCRM && crmStages.length > 0) || portfolioCompanies.length > 0;

    if (sectors.length === 0 && !customKeywords.trim() && !hasAnchors) {
      return sendResult({ error: 'Pick at least one sector or add custom keywords.' });
    }

    // Build search terms from sectors
    const sectorTerms = {
      'DeFi': ['defi protocol', 'dex swap', 'amm liquidity', 'yield farming'],
      'Betting / Gambling': ['betting protocol', 'onchain betting', 'crypto sportsbook', 'prediction market'],
      'Social Betting': ['social betting', 'parlay crypto', 'picks platform'],
      'Prediction Markets': ['prediction market', 'polymarket', 'binary outcome'],
      'Gaming': ['web3 game', 'onchain gaming', 'crypto game'],
      'NFT / Collectibles': ['nft marketplace', 'digital collectibles', 'nft launch'],
      'Social / Consumer': ['social crypto', 'web3 social', 'socialfi', 'consumer crypto'],
      'Infrastructure': ['crypto infra', 'rpc provider', 'sequencer', 'rollup'],
      'Bridge / Cross-chain': ['bridge cross-chain', 'interoperability', 'relay'],
      'AI + Crypto': ['ai agent crypto', 'ai blockchain', 'depin ai', 'crypto llm'],
      'DAO / Governance': ['dao governance', 'onchain voting', 'dao tooling'],
      'Exchange / Marketplace': ['dex launch', 'crypto exchange', 'orderbook'],
      'Options / Derivatives': ['options protocol', 'perpetual dex', 'derivatives crypto'],
      'Stablecoins': ['stablecoin protocol', 'pegged dollar'],
      'Payments': ['crypto payments', 'web3 pay'],
      'Wallet / Account': ['crypto wallet', 'account abstraction'],
      'Lending / Borrowing': ['lending protocol', 'borrow crypto', 'flash loan'],
      'Yield / Staking': ['yield farming', 'staking protocol', 'restaking'],
      'Privacy': ['privacy blockchain', 'zero knowledge', 'zk proof'],
      'RWA / Tokenization': ['real world assets', 'tokenization', 'rwa protocol'],
      'Identity / Auth': ['did identity', 'web3 auth', 'soulbound'],
      'SDK / Developer Tools': ['web3 sdk', 'blockchain developer tools'],
    };

    const keywords = [];
    for (const s of sectors) {
      const terms = sectorTerms[s] || [s.toLowerCase()];
      keywords.push(...terms.slice(0, 2));
    }
    if (customKeywords.trim()) {
      customKeywords.split(',').map(k => k.trim()).filter(Boolean).forEach(k => keywords.push(k));
    }
    const uniqueKeywords = [...new Set(keywords)].slice(0, 16);

    // Time range filter
    const dayMap = { day: 1, week: 7, month: 30, quarter: 90, year: 365 };
    const ageDays = dayMap[timeRange] || 7;
    const dateStr = new Date(Date.now() - ageDays * 86400000).toISOString().slice(0, 10);

    const allSignals = [];
    const sourceStats = { twitter: 0, farcaster: 0, github: 0, producthunt: 0, harmonic: 0 };

    // ---- TWITTER ----
    if (sources.includes('twitter') && rapidApiKey) {
      sourcesActual.push('twitter');
      sendProgress('Scanning X/Twitter...', 'import', { source: 'twitter' });
      const rapidHeaders = { 'x-rapidapi-host': 'twitter-v24.p.rapidapi.com', 'x-rapidapi-key': rapidApiKey };
      const twitterKws = uniqueKeywords.slice(0, 10);
      for (const kw of twitterKws) {
        try {
          const url = `https://twitter-v24.p.rapidapi.com/search/?query=${encodeURIComponent(kw)}&section=latest&limit=50`;
          const r = await fetch(url, { headers: rapidHeaders });
          if (r.ok) {
            const data = await r.json();
            let instructions = data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
            if (instructions.length === 0) instructions = data?.data?.search?.timeline_response?.timeline?.instructions || [];
            for (const instr of instructions) {
              for (const entry of (instr.entries || [])) {
                try {
                  const result = entry?.content?.itemContent?.tweet_results?.result;
                  if (!result?.legacy) continue;
                  const tweet = result.legacy;
                  const user = result.core?.user_results?.result?.legacy || {};
                  const followers = user.followers_count || 0;
                  const likes = tweet.favorite_count || 0;
                  if (followers < minFollowers || likes < minEngagement) continue;
                  allSignals.push({
                    source: 'twitter',
                    id: `tw-${result.rest_id || tweet.id_str}`,
                    title: user.name || '?',
                    subtitle: `@${user.screen_name || '?'}`,
                    text: (tweet.full_text || '').slice(0, 400),
                    url: user.screen_name ? `https://x.com/${user.screen_name}/status/${result.rest_id || tweet.id_str}` : null,
                    pfp: (user.profile_image_url_https || '').replace('_normal', '_bigger'),
                    followers,
                    engagement: likes + (tweet.retweet_count || 0) + (tweet.quote_count || 0),
                    likes,
                    timestamp: tweet.created_at || null,
                    meta: { retweets: tweet.retweet_count || 0, replies: tweet.reply_count || 0, quotes: tweet.quote_count || 0 },
                  });
                  sourceStats.twitter++;
                } catch (e) {}
              }
            }
          }
          await sleep(200);
        } catch (e) {}
      }
      console.log('[Super] Twitter:', sourceStats.twitter, 'signals');
    }

    // ---- FARCASTER ----
    if (sources.includes('farcaster') && neynarKey) {
      sourcesActual.push('farcaster');
      sendProgress('Scanning Farcaster...', 'import', { source: 'farcaster' });
      const farcasterKws = uniqueKeywords.slice(0, 8);
      for (const kw of farcasterKws) {
        try {
          const url = `https://api.neynar.com/v2/farcaster/cast/search?q=${encodeURIComponent(kw)}&limit=100`;
          const r = await fetch(url, { headers: { accept: 'application/json', api_key: neynarKey } });
          if (r.ok) {
            const data = await r.json();
            for (const cast of (data.result?.casts || [])) {
              const followers = cast.author?.follower_count || 0;
              const likes = (cast.reactions?.likes_count || cast.reactions?.likes?.length || 0);
              if (followers < minFollowers || likes < minEngagement) continue;
              allSignals.push({
                source: 'farcaster',
                id: `fc-${cast.hash}`,
                title: cast.author?.display_name || '?',
                subtitle: `@${cast.author?.username || '?'}`,
                text: (cast.text || '').slice(0, 400),
                url: `https://warpcast.com/${cast.author?.username}/${cast.hash?.slice(0, 10)}`,
                pfp: cast.author?.pfp_url || '',
                followers,
                engagement: likes + (cast.reactions?.recasts_count || cast.reactions?.recasts?.length || 0),
                likes,
                timestamp: cast.timestamp || null,
                meta: { recasts: cast.reactions?.recasts_count || 0, replies: cast.replies?.count || 0 },
              });
              sourceStats.farcaster++;
            }
          }
          await sleep(150);
        } catch (e) {}
      }
      console.log('[Super] Farcaster:', sourceStats.farcaster, 'signals');
    }

    // ---- GITHUB ----
    if (sources.includes('github')) {
      sourcesActual.push('github');
      sendProgress('Scanning GitHub...', 'import', { source: 'github' });
      const chainTerms = chains.filter(c => c !== 'Any Chain').map(c => c.toLowerCase());
      const ghKws = uniqueKeywords.slice(0, 6);
      for (const kw of ghKws) {
        try {
          let q = `${kw} pushed:>${dateStr}`;
          if (chainTerms.length > 0) q += ` ${chainTerms.slice(0, 2).join(' ')}`;
          const ghToken = process.env.GITHUB_TOKEN || '';
          const headers = ghToken ? { Authorization: `token ${ghToken}` } : {};
          const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=30`;
          const r = await fetch(url, { headers });
          if (r.ok) {
            const data = await r.json();
            for (const repo of (data.items || [])) {
              allSignals.push({
                source: 'github',
                id: `gh-${repo.id}`,
                title: repo.full_name || repo.name,
                subtitle: repo.language || 'Unknown',
                text: (repo.description || '').slice(0, 400),
                url: repo.html_url,
                pfp: repo.owner?.avatar_url || '',
                followers: repo.watchers_count || 0,
                engagement: (repo.stargazers_count || 0) + (repo.forks_count || 0),
                likes: repo.stargazers_count || 0,
                timestamp: repo.pushed_at || repo.updated_at || null,
                meta: { stars: repo.stargazers_count || 0, forks: repo.forks_count || 0, language: repo.language },
              });
              sourceStats.github++;
            }
          }
          await sleep(300);
        } catch (e) {}
      }
      console.log('[Super] GitHub:', sourceStats.github, 'signals');
    }

    // ---- PRODUCT HUNT ----
    if (sources.includes('producthunt')) {
      const phKey = process.env.PH_API_KEY;
      const phSecret = process.env.PH_API_SECRET;
      let phToken = process.env.PH_TOKEN; // cached token
      if (phToken || (phKey && phSecret)) sourcesActual.push('producthunt');

      if (!phToken && phKey && phSecret) {
        // Get client credentials token
        try {
          sendProgress('Authenticating with Product Hunt...', 'import', { source: 'producthunt' });
          const tokenRes = await fetch('https://api.producthunt.com/v2/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: phKey, client_secret: phSecret, grant_type: 'client_credentials' }),
          });
          if (tokenRes.ok) {
            const tokenData = await tokenRes.json();
            phToken = tokenData.access_token;
          } else {
            console.error('[Super] PH token failed:', tokenRes.status);
          }
        } catch (e) { console.error('[Super] PH auth error:', e.message); }
      }

      if (phToken) {
        sendProgress('Scanning Product Hunt...', 'import', { source: 'producthunt' });
        const phHeaders = {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${phToken}`,
        };

        // Search by topic keywords — PH uses "posts" query with topic or search
        const phKws = uniqueKeywords.slice(0, 6);
        const seenPhIds = new Set();

        for (const kw of phKws) {
          try {
            // Use posts query with order by newest, filtered by date
            const query = {
              query: `{
                posts(first: 20, order: NEWEST, postedAfter: "${dateStr}T00:00:00Z") {
                  edges {
                    node {
                      id
                      name
                      tagline
                      description
                      url
                      votesCount
                      commentsCount
                      createdAt
                      featuredAt
                      website
                      thumbnail {
                        url
                      }
                      topics {
                        edges {
                          node {
                            name
                          }
                        }
                      }
                      makers {
                        name
                        headline
                      }
                    }
                  }
                }
              }`
            };

            const r = await fetch('https://api.producthunt.com/v2/api/graphql', {
              method: 'POST',
              headers: phHeaders,
              body: JSON.stringify(query),
            });

            if (r.ok) {
              const data = await r.json();
              const posts = data?.data?.posts?.edges || [];
              console.log('[Super] PH "' + kw + '" returned', posts.length, 'posts');

              for (const edge of posts) {
                const p = edge.node;
                if (!p || seenPhIds.has(p.id)) continue;

                // Check if post matches our keyword
                const text = `${p.name} ${p.tagline} ${p.description || ''} ${(p.topics?.edges || []).map(t => t.node.name).join(' ')}`.toLowerCase();
                if (!text.includes(kw.split(' ')[0].toLowerCase())) continue;

                seenPhIds.add(p.id);
                const topics = (p.topics?.edges || []).map(t => t.node.name).join(', ');
                const makers = (p.makers || []).map(m => m.name).filter(Boolean).join(', ');

                allSignals.push({
                  source: 'producthunt',
                  id: `ph-${p.id}`,
                  title: p.name || '?',
                  subtitle: topics || 'Product Hunt',
                  text: (p.tagline || '') + (p.description ? '\n' + p.description.slice(0, 300) : ''),
                  url: p.url || p.website || '',
                  pfp: p.thumbnail?.url || '',
                  followers: 0,
                  engagement: (p.votesCount || 0) + (p.commentsCount || 0),
                  likes: p.votesCount || 0,
                  timestamp: p.createdAt || p.featuredAt || null,
                  meta: { upvotes: p.votesCount || 0, comments: p.commentsCount || 0, makers, website: p.website || '' },
                });
                sourceStats.producthunt++;
              }
            } else {
              const errText = await r.text().catch(() => '');
              console.error('[Super] PH query failed (' + r.status + '):', errText.slice(0, 200));
            }
            await sleep(300);
          } catch (e) { console.error('[Super] PH error:', e.message); }
        }
        console.log('[Super] Product Hunt:', sourceStats.producthunt, 'signals');
      } else {
        console.log('[Super] Product Hunt: skipped (no API credentials)');
      }
    }

    // ---- ANCHORS (Baselines + Portfolio + CRM) ----
    // When user provides anchor companies, fetch their similar companies from Harmonic
    // and inject them as harmonic-source signals with anchor metadata.
    let anchorContext = ''; // Used in scoring prompts
    let anchorCompanyNames = []; // For matching during scoring
    let anchorCards = [];   // Enriched baseline companies (for AI Query Expansion + self-rating)

    if (hasAnchors && harmonicKey) {
      sendProgress('Fetching anchor companies (baselines/portfolio)...', 'import', { source: 'anchors' });
      const harmonicHeaders = { apikey: harmonicKey };
      const seenAnchorIds = new Set();
      const _anchorHideIdx = buildUserHideIndex(resolvePersonId(req));

      // Determine fetch sizes based on importance (0-100 scale)
      // Importance 50 = ~50 similar, 100 = ~100 similar, 10 = ~10 similar
      const sizeFromImportance = (imp) => Math.max(10, Math.min(100, Math.round(imp)));

      // Helper: fetch similar companies for a given company id, add to allSignals
      const fetchAnchorSimilar = async (anchorCo, weight, anchorType) => {
        let id = anchorCo.id;
        // If no ID, try typeahead lookup
        if (!id && anchorCo.name) {
          try {
            const lookupRes = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(anchorCo.name)}&size=1`, { headers: harmonicHeaders });
            if (lookupRes.ok) {
              const lookupData = await lookupRes.json();
              const match = (lookupData.results || [])[0];
              if (match) id = match.id || (match.entity_urn || '').split(':').pop();
            }
          } catch (e) {}
        }
        if (!id) return 0;

        const size = sizeFromImportance(weight);
        try {
          const r = await fetch(`${HARMONIC_BASE}/search/similar_companies/${id}?size=${size}`, { headers: harmonicHeaders });
          if (!r.ok) return 0;
          const data = await r.json();
          let raw = Array.isArray(data) ? data : (data.results || data.similar_companies || data.companies || []);
          if (!raw.length) return 0;

          const alreadyFull = raw[0] && typeof raw[0] === 'object' && raw[0].name;
          let companies = [];
          if (alreadyFull) {
            companies = raw.map(c => gqlToCard(c));
          } else {
            const ids = raw.map(r => {
              if (typeof r === 'string') return r.includes(':') ? r.split(':').pop() : r;
              if (typeof r === 'number') return r;
              return r.id || (r.entity_urn || r.entityUrn || '').split(':').pop() || null;
            }).filter(Boolean);
            if (ids.length > 0) {
              const enriched = await gqlEnrichCompanies(ids, harmonicKey);
              companies = enriched.map(c => gqlToCard(c));
            }
          }

          let added = 0, skippedByFunding = 0, skippedByBackburn = 0;
          for (const c of companies) {
            const cid = String(c.id || c.entity_id || '');
            const nameKey = (c.name || '').toLowerCase().trim();
            if (!cid || seenAnchorIds.has(cid) || seenAnchorIds.has(nameKey)) continue;
            seenAnchorIds.add(cid);
            seenAnchorIds.add(nameKey);

            // Skip backburned companies — never surface them in any search
            if (isBackburned(c)) { skippedByBackburn++; continue; }
            // Skip per-user hidden
            if (isHiddenForUser(c, _anchorHideIdx)) { skippedByBackburn++; continue; }

            // Apply funding cap (deprioritize/exclude over-funded for sub-$250K checks)
            const fundingTotal = c.funding_total || 0;
            if (fundingTotal > fundingCap) { skippedByFunding++; continue; }

            const tm = c.tractionMetrics || {};
            const webGrowth = tm.webTraffic?.ago30d?.percentChange || null;
            const hcGrowth = tm.headcount?.ago90d?.percentChange || null;
            const founders = Array.isArray(c.founders) ? c.founders.map(f => f.name || f.full_name || '').filter(Boolean).join(', ') : '';

            allSignals.push({
              source: 'harmonic',
              id: `hm-${cid}`,
              title: c.name || '?',
              subtitle: c.funding_stage || c.stage || 'Unknown',
              text: (c.description || '').slice(0, 300),
              url: c.website?.url || c.website?.domain || c.website || '',
              pfp: c.logo_url || c.logoUrl || '',
              followers: c.headcount || 0,
              engagement: c.funding_total || 0,
              likes: 0,
              timestamp: c.created_at || c.founded_date || null,
              meta: {
                funding: c.funding_total || 0,
                stage: c.funding_stage || c.stage,
                headcount: c.headcount,
                website: c.website?.url || c.website || '',
                founders, webGrowth, hcGrowth,
              },
              _anchor: { type: anchorType, weight, baseline: anchorCo.name },
            });
            sourceStats.harmonic = (sourceStats.harmonic || 0) + 1;
            added++;
          }
          return added;
        } catch (e) {
          console.error(`[Super/Anchor] error fetching similar for ${anchorCo.name}:`, e.message);
          return 0;
        }
      };

      // Process baselines
      if (baselines.length > 0) {
        anchorCompanyNames.push(...baselines.map(b => b.name));
        for (const b of baselines) {
          const n = await fetchAnchorSimilar(b, baselineImportance, 'baseline');
          console.log(`[Super/Anchor] baseline "${b.name}" → ${n} similar companies`);
        }
        anchorContext += `BASELINE COMPANIES (importance ${baselineImportance}%): ${baselines.map(b => b.name).join(', ')}\n`;

        // Enrich baseline companies themselves (rich data for AI Query Expansion + self-rating)
        try {
          const baselineIds = baselines.map(b => b.id).filter(Boolean);
          if (baselineIds.length > 0) {
            const enriched = await gqlEnrichCompanies(baselineIds, harmonicKey);
            anchorCards = enriched.map(c => gqlToCard(c));
            console.log(`[Super/Anchor] enriched ${anchorCards.length} baseline companies for query gen`);
          }
        } catch (e) { console.error('[Super/Anchor] baseline enrich error:', e.message); }
      }

      // Process portfolio
      if (portfolioCompanies.length > 0) {
        anchorCompanyNames.push(...portfolioCompanies.map(p => p.name));
        for (const p of portfolioCompanies) {
          const n = await fetchAnchorSimilar(p, portfolioImportance, 'portfolio');
          console.log(`[Super/Anchor] portfolio "${p.name}" → ${n} similar companies`);
        }
        anchorContext += `PORTFOLIO ANCHORS (importance ${portfolioImportance}%): ${portfolioCompanies.map(p => p.name).join(', ')}\n`;
      }

      // Process CRM (fetch from Airtable as context)
      if (includeCRM && crmStages.length > 0) {
        try {
          const airtableHdrs = (typeof airtableHeaders === 'function') ? airtableHeaders() : null;
          const airtableBaseId = process.env.AIRTABLE_BASE_ID;
          if (airtableHdrs && airtableBaseId) {
            const crmNames = [];
            for (const stage of crmStages) {
              try {
                const formula = encodeURIComponent(`{CRM Stage} = "${stage}"`);
                const url = `${AIRTABLE_API}/${airtableBaseId}/${AIRTABLE_TABLE}?maxRecords=50&filterByFormula=${formula}`;
                const r = await fetch(url, { headers: airtableHdrs });
                if (r.ok) {
                  const data = await r.json();
                  for (const rec of (data.records || [])) {
                    const name = (rec.fields['Company'] || '').trim();
                    if (name) crmNames.push(name);
                  }
                }
              } catch (e) {}
            }
            anchorCompanyNames.push(...crmNames);
            anchorContext += `CRM PIPELINE (importance ${crmImportance}%, stages ${crmStages.join('/')}): ${crmNames.slice(0, 30).join(', ')}${crmNames.length > 30 ? ` (+${crmNames.length - 30} more)` : ''}\n`;
            console.log(`[Super/Anchor] CRM context: ${crmNames.length} companies from ${crmStages.join('/')}`);
          }
        } catch (e) { console.error('[Super/Anchor] CRM fetch error:', e.message); }
      }

      sendProgress(`Anchors loaded — ${sourceStats.harmonic || 0} similar companies from Harmonic`, 'import', { source: 'anchors' });

      // ── AI QUERY EXPANSION (Max/Extreme tiers) ──
      // Harmonic Similar caps at 100 per anchor. To leverage Harmonic's full 1M+ DB,
      // we have Claude analyze the baselines + additional info, then generate diverse
      // natural-language queries that hit Harmonic's search_agent endpoint (which can
      // return up to 1000 per query). Each query approaches from a different angle —
      // sector, business model, technology, geography, customer type, adjacent verticals.
      // Result: 1000-3000+ candidates from across the database, NOT just narrow archetypes.
      const enableQueryExpansion = ['opus80', 'extreme'].includes(superTier);
      if (enableQueryExpansion && anthropicKey) {
        const numQueries = superTier === 'extreme' ? 50 : 20;
        const querySize = superTier === 'extreme' ? 1000 : 500;  // Harmonic max is 1000

        // Step 1: Build context from baselines + additional info
        const baselineDescs = anchorCards && anchorCards.length > 0
          ? anchorCards.map(a => `- ${a.name}: ${(a.description || '').slice(0, 250)}\n  Stage: ${a.funding_stage || '?'} | Funding: ${a.funding_total ? '$' + (a.funding_total/1e6).toFixed(1) + 'M' : '?'} | Location: ${a.location || '?'} | Founders: ${(a.founders||[]).map(f => f.name || f).filter(Boolean).slice(0,3).join(', ') || '?'}`).join('\n')
          : baselines.map(b => `- ${b.name}`).join('\n');

        sendProgress(`Generating ${numQueries} diverse search queries via Claude...`, 'import', { source: 'ai-query-gen' });

        const queryGenPrompt = `You are designing a Harmonic database search to find companies relevant to these baseline anchors:

${baselineDescs}
${additionalInfo ? `\nADDITIONAL CONTEXT:\n${additionalInfo.slice(0, 6000)}\n` : ''}
Generate ${numQueries} DIVERSE natural-language search queries that approach from DIFFERENT angles:
- Core sector/subsector terms
- Business model variants (B2B SaaS, hardware+SaaS, marketplace, infra, etc.)
- Technology category (LLM, sensor, blockchain, edge compute, etc.)
- Customer/market type (SMB, enterprise, prosumer, etc.)
- Geographic variants (US, EU, Asia, LatAm, MENA)
- Adjacent verticals (companies serving similar customers but with different products)
- Competitor/replacement archetypes
- Stage-fit terms (seed-stage, early-stage, bootstrapped)
- Specific use cases / problems being solved
- Founder backgrounds (deep tech, ex-FAANG, repeat founder)

Each query: 3-9 words, optimized for Harmonic's semantic search agent. Be CREATIVE — these queries will be UNIONED to maximize recall across Harmonic's 1M+ company database. Prefer diverse over redundant.

Output STRICT JSON only:
${'```'}json
{"queries": ["query 1", "query 2", "..."]}
${'```'}`;

        let queries = [];
        try {
          const qr = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: queryGenPrompt }] }),
          });
          if (qr.ok) {
            const qd = await qr.json();
            recordUsage('claude-haiku-4-5-20251001', qd.usage);
            const txt = qd.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
            const m = txt.match(/```json\s*\n?([\s\S]*?)\n?```/);
            if (m) {
              const parsed = JSON.parse(m[1]);
              queries = (parsed.queries || []).filter(q => typeof q === 'string' && q.trim()).slice(0, numQueries);
            }
          }
        } catch (e) { console.error('[Super/AIExpand] query-gen error:', e.message); }

        console.log(`[Super/AIExpand] generated ${queries.length} queries:`, queries);
        if (queries.length > 0) {
          sendProgress(`Running ${queries.length} Harmonic queries × size=${querySize} (search_agent + keyword filter)...`, 'import', { source: 'ai-query-run', queries: queries.length });

          // Step 2: Run each query via BOTH search_agent (semantic) AND companies_by_keywords
          // (keyword filter). Two endpoints hit different distributions of the database.
          // Capture rich data from response — skip GQL enrichment for non-survivors (huge speedup).
          const harmonicHdrs = { apikey: harmonicKey };
          const liteCompanyMap = new Map();  // id → lite company (for Sonnet screening)
          let queriesRun = 0;

          // Helper: extract lite company data from a search_agent result row
          const extractLite = (rr) => {
            if (typeof rr === 'string') return { id: rr.includes(':') ? rr.split(':').pop() : rr };
            if (typeof rr === 'number') return { id: String(rr) };
            const id = rr.id || (rr.urn || rr.entity_urn || '').split(':').pop();
            if (!id) return null;
            return {
              id: String(id),
              name: rr.name || rr.company_name || rr.display_name || '',
              description: rr.description || rr.short_description || rr.tagline || '',
              website: rr.website?.url || rr.website?.domain || rr.homepage_url || '',
              funding_total: rr.funding_total || rr.total_funding_amount || rr.funding?.fundingTotal || 0,
              funding_stage: rr.stage || rr.funding_stage || rr.funding?.fundingStage || '',
              headcount: rr.headcount || null,
              location: rr.location?.city ? `${rr.location.city}, ${rr.location.country || ''}`.trim() : (rr.location || ''),
              logo_url: rr.logo_url || rr.logoUrl || '',
              founders: rr.founders || [],
            };
          };

          const collect = (results, queryStr) => {
            let added = 0;
            for (const rr of (results || [])) {
              const lite = extractLite(rr);
              if (!lite || !lite.id || seenAnchorIds.has(lite.id) || liteCompanyMap.has(lite.id)) continue;
              // Apply funding cap during pool building if rich data available; if no funding info, INCLUDE (pre-funding/undisclosed)
              if (lite.funding_total > 0 && lite.funding_total > fundingCap) continue;
              liteCompanyMap.set(lite.id, { ...lite, _foundVia: queryStr });
              added++;
            }
            return added;
          };

          for (const q of queries) {
            if (isCancelled()) {
              clearInterval(keepAlive);
              console.log(`[Super] Cancelled during AI Query Expansion (queries ran: ${queriesRun})`);
              return sendResult({ error: 'Cancelled by user', cancelled: true, signals: [], totalSignals: 0 });
            }
            // Endpoint 1: search_agent (semantic) — size up to 1000
            try {
              const url1 = `${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(q)}&size=${Math.min(querySize, 1000)}`;
              const r1 = await fetch(url1, { headers: harmonicHdrs });
              if (r1.ok) {
                const data = await r1.json();
                const results = data.results || data.companies || data.data || [];
                const added = collect(results, q);
                console.log(`[Super/AIExpand] search_agent "${q}" → ${results.length} raw, +${added} new (pool: ${liteCompanyMap.size})`);
              } else {
                console.error(`[Super/AIExpand] search_agent "${q}" HTTP ${r1.status}`);
              }
            } catch (e) { console.error(`[Super/AIExpand] search_agent error:`, e.message); }
            await sleep(60);

            // Endpoint 2: companies_by_keywords (keyword filter) — different distribution
            try {
              const params = new URLSearchParams({ size: '500', include_ids_only: 'false' });
              params.set('contains_any_of_keywords', q);
              const r2 = await fetch(`${HARMONIC_BASE}/search/companies_by_keywords?${params}`, {
                method: 'POST', headers: { ...harmonicHdrs, 'Content-Type': 'application/json' }
              });
              if (r2.ok) {
                const data = await r2.json();
                const results = data.results || data.companies || data.data || [];
                const added = collect(results, q);
                console.log(`[Super/AIExpand] keywords "${q}" → ${results.length} raw, +${added} new (pool: ${liteCompanyMap.size})`);
              }
            } catch (e) { /* keyword endpoint is best-effort */ }
            await sleep(60);

            queriesRun++;
            if (queriesRun % 5 === 0 || queriesRun === queries.length) {
              sendProgress(`Query ${queriesRun}/${queries.length} — pool: ${liteCompanyMap.size} unique candidates`, 'import', { source: 'ai-query-run', queriesRun, total: liteCompanyMap.size });
            }
          }

          // Step 3: Push lite signals into allSignals (skip enrichment for now — done after Sonnet)
          // Sonnet can screen on lite data alone (name + description + funding).
          // Only top survivors get GQL-enriched right before Opus 5-dim scoring.
          let pushedLite = 0;
          for (const [, c] of liteCompanyMap) {
            const nameKey = (c.name || '').toLowerCase().trim();
            if (!c.name || seenAnchorIds.has(c.id) || seenAnchorIds.has(nameKey)) continue;
            seenAnchorIds.add(c.id);
            seenAnchorIds.add(nameKey);
            allSignals.push({
              source: 'harmonic',
              id: `hm-${c.id}`,
              title: c.name,
              subtitle: c.funding_stage || 'Unknown',
              text: (c.description || '').slice(0, 300),
              url: c.website || '',
              pfp: c.logo_url || '',
              followers: c.headcount || 0,
              engagement: c.funding_total || 0,
              likes: 0,
              timestamp: null,
              meta: {
                funding: c.funding_total || 0,
                stage: c.funding_stage,
                headcount: c.headcount,
                website: c.website,
                founders: Array.isArray(c.founders) ? c.founders.map(f => f.name || f).filter(Boolean).join(', ') : '',
                location: c.location,
                _lite: true,  // marker — not yet GQL-enriched
              },
              _anchor: { type: 'ai-expansion', weight: baselineImportance, baseline: baselines[0]?.name || '' },
            });
            sourceStats.harmonic++;
            pushedLite++;
          }
          console.log(`[Super/AIExpand] AI Query Expansion COMPLETE: ${queries.length} queries × 2 endpoints, +${pushedLite} lite signals. Total pool: ${sourceStats.harmonic}`);
          sendProgress(`AI expansion complete: +${pushedLite} candidates (lite). Total pool: ${sourceStats.harmonic}`, 'import', { source: 'ai-query-done', added: pushedLite, totalPool: sourceStats.harmonic });
        }
      }
    }

    // ---- HARMONIC ----
    if (sources.includes('harmonic') && harmonicKey) {
      sourcesActual.push('harmonic');
      sendProgress('Scanning Harmonic database...', 'import', { source: 'harmonic' });
      const harmonicHeaders = { apikey: harmonicKey };
      // Map stage labels to Harmonic API values
      const stageMap = {
        'Pre-Seed': 'pre_seed',
        'Seed': 'seed',
        'Series A': 'series_a',
        'Series B+': 'series_b',
        'No raise / Bootstrapped': 'bootstrapped',
      };
      const stageFilters = (Array.isArray(stage) ? stage : []).filter(s => s !== 'Any stage').map(s => stageMap[s] || s);
      const hKws = uniqueKeywords.slice(0, 6);
      const seenHmIds = new Set();   // dedupe across original + auto-widen passes
      const kwCounts = {};
      let harmonicAddedThisPass = 0;

      // Reusable per-query fetch — pushes into allSignals, returns count added.
      const runHarmonicKw = async (kw, anchorTag) => {
        let added = 0;
        try {
          const searchUrl = `${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(kw)}&size=15`;
          console.log('[Super] Harmonic search:', kw, anchorTag === 'widen' ? '(widened)' : '');
          const r = await fetch(searchUrl, { headers: harmonicHeaders });
          if (!r.ok) {
            const errText = await r.text().catch(() => '');
            console.error('[Super] Harmonic "' + kw + '" failed (' + r.status + '):', errText.slice(0, 200));
            return 0;
          }
          const data = await r.json();
          const companies = data.results || data.data || data.companies || [];
          console.log('[Super] Harmonic "' + kw + '" returned', companies.length, 'companies');
          for (const c of companies) {
            const cid = c.id || c.entity_id;
            if (!cid) continue;
            if (seenHmIds.has(cid)) continue;
            seenHmIds.add(cid);
            const desc = c.description || c.short_description || c.tagline || '';
            const funding = c.funding_total || c.total_funding_amount || 0;
            const compStage = c.stage || c.funding_stage || '';
            if (stageFilters.length > 0) {
              const compStageLower = (compStage || '').toLowerCase().replace(/[\s-]/g, '_');
              const noFunding = !funding || funding === 0;
              const matchesStage = stageFilters.some(sf => sf === 'bootstrapped' ? noFunding : compStageLower.includes(sf));
              if (!matchesStage) continue;
            }
            const tm = c.tractionMetrics || {};
            const webGrowth = tm.webTraffic?.ago30d?.percentChange || null;
            const hcGrowth = tm.headcount?.ago90d?.percentChange || null;
            const engGrowth = tm.headcountEngineering?.ago90d?.percentChange || null;
            const highlights = (c.highlights || []).map(h => h.text || h).filter(Boolean).slice(0, 2);
            const founders = Array.isArray(c.founders) ? c.founders.map(f => f.name || f.full_name || '').filter(Boolean).join(', ') : '';
            allSignals.push({
              source: 'harmonic',
              id: `hm-${cid}`,
              title: c.name || c.company_name || c.display_name || '?',
              subtitle: compStage || 'Unknown stage',
              text: desc.slice(0, 300) + (highlights.length ? '\n💡 ' + highlights.join(' | ') : ''),
              url: c.website?.url || c.website?.domain || c.homepage_url || '',
              pfp: c.logo_url || '',
              followers: c.headcount || 0,
              engagement: funding,
              likes: 0,
              timestamp: c.created_at || c.founded_date || null,
              meta: { funding, stage: compStage, headcount: c.headcount, website: c.website?.url || c.homepage_url || '', founders, webGrowth, hcGrowth, engGrowth, _autoWiden: anchorTag === 'widen' ? kw : undefined },
            });
            sourceStats.harmonic++;
            added++;
          }
        } catch (e) { console.error('[Super] Harmonic kw error:', e.message); }
        return added;
      };

      // Pass 1: original keywords
      for (const kw of hKws) {
        const n = await runHarmonicKw(kw, 'kw');
        kwCounts[kw] = n;
        harmonicAddedThisPass += n;
        await sleep(200);
      }

      // Pass 2: auto-widen if pool is thin (< 10 total) AND user opted in (or legacy null).
      // optedIntoWiden: false = explicit user opt-out (frontend toggle), true = explicit on,
      // null = legacy behavior (on by default) for back-compat with old frontends.
      const narrowKws = Object.entries(kwCounts).filter(([, n]) => n < 5).map(([k]) => k);
      const widenAllowed = optedIntoWiden !== false;
      if (!widenAllowed && harmonicAddedThisPass < 10) {
        sendProgress(`Harmonic returned only ${harmonicAddedThisPass} — auto-widen disabled by user, keeping thin pool.`, 'import', { source: 'harmonic-widen-skipped-by-user' });
      }
      if (widenAllowed && harmonicAddedThisPass < 10 && narrowKws.length > 0 && anthropicKey) {
        sendProgress(`Harmonic returned only ${harmonicAddedThisPass} — asking Haiku to widen "${narrowKws.join(', ')}"...`, 'import', { source: 'harmonic-widen-gen', narrow: narrowKws });
        try {
          const wprompt = `You are widening narrow Harmonic search queries to find more early-stage startups.

NARROW KEYWORDS THAT RETURNED FEW RESULTS:
${narrowKws.map(k => `- "${k}"`).join('\n')}

SECTORS: ${(sectors || []).join(', ') || '(none)'}
ANCHORS: ${(baselines || []).map(b => b.name).join(', ') || '(none)'}

Suggest 5 BROADER synonym/adjacent keywords (TOTAL, not per input) that:
- Cover the same investment thesis but use different vocabulary
- Are 1-3 words each, optimized for semantic search
- Are DIVERSE (different angles: tech category, customer type, adjacent vertical)
- Stay relevant to early-stage startups

Output STRICT JSON only:
\`\`\`json
{"expansions": ["kw1", "kw2", "kw3", "kw4", "kw5"]}
\`\`\``;
          const wr = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: wprompt }] }),
          });
          if (wr.ok) {
            const wd = await wr.json();
            if (typeof recordUsage === 'function') recordUsage('claude-haiku-4-5-20251001', wd.usage);
            const txt = (wd.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
            const m = txt.match(/```json\s*\n?([\s\S]*?)\n?```/) || [null, txt];
            try {
              const parsed = JSON.parse(m[1]);
              const expansions = (parsed.expansions || []).filter(s => typeof s === 'string' && s.trim() && s.length < 60).map(s => s.trim()).slice(0, 5);
              if (expansions.length) {
                sendProgress(`Auto-widening Harmonic with: ${expansions.join(', ')}`, 'import', { source: 'harmonic-widen-run', expansions });
                let widenedAdded = 0;
                for (const ekw of expansions) {
                  widenedAdded += await runHarmonicKw(ekw, 'widen');
                  await sleep(200);
                }
                sendProgress(`Auto-widen added ${widenedAdded} companies (total Harmonic: ${sourceStats.harmonic})`, 'import', { source: 'harmonic-widen-done', added: widenedAdded });
              } else {
                sendProgress('Auto-widen returned no usable expansions', 'import', { source: 'harmonic-widen-empty' });
              }
            } catch (pe) {
              console.error('[Super/Widen] JSON parse failed:', pe.message, 'raw:', m[1]?.slice(0, 200));
              sendProgress('Auto-widen JSON parse failed — keeping original results', 'import', { source: 'harmonic-widen-fail' });
            }
          } else {
            console.error('[Super/Widen] Haiku HTTP', wr.status);
            sendProgress(`Auto-widen Haiku call failed (${wr.status})`, 'import', { source: 'harmonic-widen-fail' });
          }
        } catch (e) {
          console.error('[Super/Widen] error:', e.message);
          sendProgress(`Auto-widen error: ${e.message}`, 'import', { source: 'harmonic-widen-fail' });
        }
      }
      console.log('[Super] Harmonic:', sourceStats.harmonic, 'signals (after any widen)');
    }

    // Compute which requested sources skipped (missing API keys)
    for (const s of sourcesRequested) {
      if (sourcesActual.includes(s)) continue;
      const reasons = {
        twitter: 'RAPIDAPI_KEY env var not set',
        farcaster: 'NEYNAR_API_KEY env var not set',
        producthunt: 'PH_API_KEY/PH_API_SECRET env vars not set',
        harmonic: 'HARMONIC_API_KEY env var not set',
      };
      sourcesSkipped.push({ source: s, reason: reasons[s] || 'unavailable' });
    }
    if (sourcesSkipped.length > 0) {
      console.log('[Super] Sources skipped:', sourcesSkipped);
      sendProgress(`⚠ Sources skipped: ${sourcesSkipped.map(s => s.source).join(', ')} (missing env keys)`, 'import', { skipped: sourcesSkipped });
    }

    const totalSignals = allSignals.length;
    console.log('[Super] Total signals:', totalSignals, 'breakdown:', JSON.stringify(sourceStats), '| sourcesActual:', sourcesActual, '| skipped:', sourcesSkipped.map(s => s.source));

    if (totalSignals === 0) {
      return sendResult({ signals: [], analysis: null, sourceStats, totalSignals: 0, error: 'No signals found. Try broader topics or enable more sources.' });
    }

    // Dedupe by stable identifier, falling back to text only when no id/url/title exists.
    // Text-prefix-only dedupe (the old way) collapsed Jake's 757 Farcaster signals + many
    // Harmonic cards with empty descriptions down to 4 visible results — the prefix was
    // identical across legitimately distinct signals.
    sendProgress(`Filtering ${totalSignals} signals — deduplicating...`, 'filter', { total: totalSignals });
    const seen = new Set();
    let deduped = allSignals.filter(s => {
      const idKey = s.id ? `id:${s.id}` : null;
      const urlKey = s.url ? `url:${(s.url || '').toLowerCase().replace(/[?#].*$/, '')}` : null;
      const titleKey = s.title ? `title:${(s.title || '').toLowerCase().trim()}` : null;
      const textKey = (s.text || '').slice(0, 80).toLowerCase().trim();
      // Pick the strongest key available — id > url > title > text. Empty text falls back
      // to a per-row unique sentinel so blank-description signals don't collapse to one.
      const key = idKey || urlKey || titleKey || (textKey || `nokey:${Math.random()}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Final backburn + per-user-hide pass — catches signals from non-anchor sources (Twitter/PH/Farcaster/GH)
    const beforeBurn = deduped.length;
    deduped = filterBackburn(deduped);
    const _superHideIdx = buildUserHideIndex(resolvePersonId(req));
    deduped = filterUserHidden(deduped, _superHideIdx);
    if (beforeBurn !== deduped.length) {
      console.log(`[Super/Filter] Dropped ${beforeBurn - deduped.length} signals (backburn+user-hide), ${deduped.length} remain`);
    }

    // Process ALL deduped signals through Sonnet in batches (no cap)
    sendProgress(`${deduped.length} unique signals — sorting by engagement...`, 'filter', { deduped: deduped.length });
    const sorted = [...deduped].sort((a, b) => b.engagement - a.engagement);
    const forClaude = sorted; // Process ALL — no cap

    // ── ANCHOR SELF-RATING (merit mode) ──
    // Rate each baseline anchor on the 5-dim framework so we have a sanity-check
    // ceiling. A surfaced company that just resembles the anchor cannot exceed
    // the anchor's own score unless it materially outperforms on >=1 dimension.
    const anchorRatings = {}; // { baselineName: { final, pedigree, traction, capital, investor, defensibility } }
    if (meritMode && anthropicKey && baselines.length > 0) {
      sendProgress('Rating anchor companies for sanity-check ceiling...', 'screen', { stage: 'anchor-rating' });
      // Re-use enriched anchor data from the anchor-fetch phase (no duplicate GQL call)
      if (anchorCards.length === 0) {
        try {
          const anchorIds = baselines.map(b => b.id).filter(Boolean);
          const anchorEnriched = await gqlEnrichCompanies(anchorIds, harmonicKey);
          anchorCards = anchorEnriched.map(c => gqlToCard(c));
        } catch (e) { console.error('[Super/Merit] Anchor enrich error:', e.message); }
      }

      for (const a of anchorCards) {
        const profile = `${a.name}
Funding: ${a.funding_total ? '$' + (a.funding_total/1e6).toFixed(1) + 'M' : 'undisclosed'} | Stage: ${a.funding_stage || 'unknown'}
Headcount: ${a.headcount || '?'} | Location: ${a.location || '?'}
Founders: ${(a.founders || []).map(f => typeof f === 'string' ? f : f.name).filter(Boolean).join(', ') || 'unknown'}
Investors: ${(a.investors || []).map(i => i.name || i).join(', ').slice(0, 300) || 'undisclosed'}
Description: ${(a.description || '').slice(0, 600)}`;

        const anchorPrompt = buildMeritPrompt({
          companies: [profile],
          anchorContext: '',  // anchor itself — no anchor context
          additionalInfo: additionalInfo.slice(0, 4000),
          isAnchorSelfRating: true,
          anchorName: a.name,
        });

        try {
          const ar = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 1500, messages: [{ role: 'user', content: anchorPrompt }] }),
          });
          if (ar.ok) {
            const ad = await ar.json();
            recordUsage('claude-opus-4-6', ad.usage);
            const txt = ad.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
            const m = txt.match(/```json\s*\n?([\s\S]*?)\n?```/);
            if (m) {
              const parsed = JSON.parse(m[1]);
              const v = parsed[a.name] || Object.values(parsed)[0];
              if (v) {
                const final = computeWeightedScore(v) + applyModifiers(v.modifiers);
                anchorRatings[a.name.toLowerCase()] = {
                  final: Math.max(0, Math.min(10, final)),
                  pedigree: v.pedigree || 5, traction: v.traction || 5,
                  capital: v.capital || 5, investor: v.investor || 5, defensibility: v.defensibility || 5,
                  bottom_line: v.bottom_line || '',
                };
                console.log(`[Super/Merit] Anchor ${a.name} self-rated: ${anchorRatings[a.name.toLowerCase()].final.toFixed(2)}/10`);
              }
            }
          }
        } catch (e) { console.error(`[Super/Merit] Anchor rating error for ${a.name}:`, e.message); }
      }
    }
    
    const estSonnetCost = forClaude.length * 0.001;
    const estOpusCost = useOpus ? Math.min(opusTopN, forClaude.length) * 0.015 : 0;
    const estTotalCost = estSonnetCost + estOpusCost;
    console.log(`[Super] Will score ${forClaude.length} signals (est: $${estTotalCost.toFixed(2)}, tier: ${superTier})`);

    // Claude batched Sonnet screening
    if (anthropicKey && forClaude.length > 0) {
      const BATCH_SIZE = 30;
      const totalBatches = Math.ceil(forClaude.length / BATCH_SIZE);
      const allRatings = {};
      const allAnalyses = [];
      let totalHigh = 0, totalMedium = 0, totalLow = 0;

      sendProgress(`Screening ${forClaude.length} signals with Sonnet (${totalBatches} batch${totalBatches > 1 ? 'es' : ''})...`, 'screen', { total: forClaude.length, batches: totalBatches });

      for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        const batchStart = batchIdx * BATCH_SIZE;
        if (isCancelled()) {
          clearInterval(keepAlive);
          console.log(`[Super] Cancelled during Sonnet screening (batch ${batchIdx}/${totalBatches})`);
          return sendResult({ error: 'Cancelled by user', cancelled: true, signals: forClaude.slice(0, batchStart), totalSignals });
        }
        const batch = forClaude.slice(batchStart, batchStart + BATCH_SIZE);

        sendProgress(`Sonnet batch ${batchIdx + 1}/${totalBatches} — ${Object.keys(allRatings).length} rated, ${totalHigh} HIGH so far`, 'screen', {
          batch: batchIdx + 1, totalBatches, rated: Object.keys(allRatings).length, high: totalHigh
        });

        const signalText = batch.map((s, i) =>
          `[${batchStart + i + 1}] SOURCE:${s.source.toUpperCase()} | ${s.title} (${s.subtitle}) | Followers:${s.followers} Engagement:${s.engagement}\n${s.text}`
        ).join('\n\n');

        const prompt = `You are a deal scout for Daxos Capital (Pre-Seed/Seed, $100K-$250K checks). Crypto/AI/fintech focus, but evaluate any sector on merit.

You're reviewing ${batch.length} signals from MULTIPLE sources: Twitter/X, Farcaster, GitHub repos, Product Hunt, and Harmonic company database.
${anchorContext ? `\nSEARCH SCOPE — User asked us to find companies similar to these baselines (this defines WHAT to look for, NOT how to rate):\n${anchorContext}\nThese signals are ALREADY filtered to be similar — do not give similarity bonus points. Rate each company purely on its own investment merit (see criteria below).\n` : ''}${additionalInfo ? `\nADDITIONAL CONTEXT FROM USER (apply this to your scoring — what to prioritize, avoid, or look for):\n${additionalInfo.slice(0, 8000)}\n` : ''}
RATE EACH SIGNAL on INVESTMENT MERIT — not on similarity to anchors. The signals are already similar; the question is which would actually be a good investment.

INVESTMENT MERIT CRITERIA (in priority order):
1. Founder pedigree — repeat founder, prior exit, top-tier company alumni, technical depth, domain expertise
2. Idea quality — solving a real problem, novel angle, defensible moat, clear "why now"
3. Traction signals — revenue, real user growth, GitHub stars/forks, web growth, headcount growth
4. Stage/valuation fit — Pre-Seed/Seed checks, not over-funded, not too late
5. Undervaluation — overlooked thesis, contrarian timing, mispriced relative to traction

RATING:
- HIGH: Clear investment merit — strong founder + good idea + traction OR overlooked gem at right stage
- MEDIUM: Has 1-2 of the criteria but missing others — worth a follow-up
- LOW: Weak on merit — generic idea, no traction, wrong stage, established/mature, or noise

BE STRICT. Default to LOW. Don't inflate scores because a company is "similar to the baseline" — that's a given. We're hunting for companies that would be a good investment on their OWN merit.
STEALTH COMPANIES (named "Stealth Company (Person)"): Default LOW unless founder has clearly exceptional pedigree (prior $10M+ exit + crypto/fintech).
Companies with $10M+ funding: bias toward LOW unless exceptional fit at this stage.

IMPORTANT: Respond ONLY with a JSON block. Numbers must match the signal numbers shown.
${'```'}json
{${batch.map((_, i) => `"${batchStart + i + 1}":{"signal":"LOW","company":null}`).join(',')}}
${'```'}

SIGNALS:
${signalText}`;

        try {
          const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: screenModel, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
          });

          if (claudeRes.ok) {
            const data = await claudeRes.json();
            recordUsage(screenModel, data.usage);
            const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

            try {
              const jsonMatch = text.match(/```json\s*\n?([\s\S]*?)\n?```/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[1]);
                for (const [k, v] of Object.entries(parsed)) {
                  if (typeof v === 'string') allRatings[k] = { signal: v, company: null };
                  else allRatings[k] = { signal: v.signal || 'LOW', company: v.company || null };
                  const sig = (typeof v === 'string' ? v : v.signal) || 'LOW';
                  if (sig === 'HIGH') totalHigh++;
                  else if (sig === 'MEDIUM') totalMedium++;
                  else totalLow++;
                }
              }
              const analysisText = text.replace(/```json[\s\S]*?```\s*\n?/, '').trim();
              if (analysisText) allAnalyses.push(analysisText);
            } catch (e) { console.error(`[Super] Batch ${batchIdx + 1} parse error:`, e.message); }
            
            console.log(`[Super] Batch ${batchIdx + 1}/${totalBatches}: ${Object.keys(allRatings).length} rated (H:${totalHigh} M:${totalMedium} L:${totalLow})`);
          } else {
            console.error(`[Super] Sonnet batch ${batchIdx + 1} failed: ${claudeRes.status}`);
          }
        } catch (e) {
          console.error(`[Super] Sonnet batch ${batchIdx + 1} error:`, e.message);
        }
        if (batchIdx < totalBatches - 1) await sleep(500);
      }

      sendProgress(`Sonnet done — ${totalHigh} HIGH, ${totalMedium} MEDIUM out of ${forClaude.length}`, 'screen', { high: totalHigh, medium: totalMedium, low: totalLow });
      console.log(`[Super] SONNET DONE: ${Object.keys(allRatings).length}/${forClaude.length} rated. H:${totalHigh} M:${totalMedium} L:${totalLow}`);

      // Apply ratings
      const rated = forClaude.map((s, i) => ({
        ...s,
        signal: allRatings[String(i + 1)]?.signal || 'LOW',
        companyName: allRatings[String(i + 1)]?.company || null,
      }));

      const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      rated.sort((a, b) => {
        const sigDiff = (order[a.signal] || 2) - (order[b.signal] || 2);
        if (sigDiff !== 0) return sigDiff;
        return b.engagement - a.engagement;
      });

      let cleanAnalysis = allAnalyses.join('\n\n').trim() || '';

      // OPTIONAL: Opus deep scoring on top signals
      let opusAnalysis = '';
      if (useOpus && anthropicKey) {
        // ── MERIT-MODE 5-DIM SCORING (when anchors are present) ──
        if (meritMode) {
          // Pool: top N signals by signal/engagement, must be harmonic-source companies
          const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
          const meritPool = rated
            .filter(s => s.source === 'harmonic')  // company-source signals only
            .sort((a, b) => {
              const sigDiff = (order[a.signal] || 2) - (order[b.signal] || 2);
              if (sigDiff !== 0) return sigDiff;
              return (b.engagement || 0) - (a.engagement || 0);
            })
            .slice(0, opusTopN);

          // ON-DEMAND ENRICHMENT — only the top-N survivors get full GQL data.
          // Lite signals from AI Query Expansion need rich data for Opus to score founders/investors/IP properly.
          const liteToEnrich = meritPool.filter(s => s.meta?._lite).map(s => String(s.id || '').replace('hm-', '')).filter(Boolean);
          if (liteToEnrich.length > 0) {
            sendProgress(`Enriching top ${liteToEnrich.length} survivors with full Harmonic data...`, 'meritscore', { phase: 'enrich-survivors', total: liteToEnrich.length });
            const ENRICH_BATCH = 100;
            for (let i = 0; i < liteToEnrich.length; i += ENRICH_BATCH) {
              const batchIds = liteToEnrich.slice(i, i + ENRICH_BATCH);
              try {
                const enriched = await gqlEnrichCompanies(batchIds, harmonicKey);
                for (const c of enriched) {
                  const card = gqlToCard(c);
                  const cid = String(card.id || card.entity_id || '');
                  // Find matching signal in meritPool and replace its lite data with rich data
                  const sig = meritPool.find(s => String(s.id || '').replace('hm-', '') === cid);
                  if (!sig) continue;
                  const tm = card.tractionMetrics || {};
                  const founders = Array.isArray(card.founders) ? card.founders.map(f => f.name || f.full_name || '').filter(Boolean).join(', ') : '';
                  sig.text = (card.description || sig.text || '').slice(0, 500);
                  sig.url = card.website?.url || card.website?.domain || sig.url || '';
                  sig.pfp = card.logo_url || card.logoUrl || sig.pfp || '';
                  sig.subtitle = card.funding_stage || card.stage || sig.subtitle;
                  sig.engagement = card.funding_total || sig.engagement || 0;
                  sig.followers = card.headcount || sig.followers || 0;
                  sig.meta = {
                    ...sig.meta,
                    funding: card.funding_total || sig.meta.funding || 0,
                    stage: card.funding_stage || card.stage,
                    headcount: card.headcount,
                    website: card.website?.url || card.website || sig.meta.website || '',
                    founders,
                    investors: (card.investors || []).map(i => i.name || i).filter(Boolean).slice(0, 8).join(', '),
                    location: card.location || sig.meta.location || '',
                    webGrowth: tm.webTraffic?.ago30d?.percentChange || null,
                    hcGrowth: tm.headcount?.ago90d?.percentChange || null,
                    _lite: false,
                  };
                }
              } catch (e) { console.error(`[Super/Merit] enrich-survivors batch ${i} error:`, e.message); }
            }
            console.log(`[Super/Merit] Enriched ${liteToEnrich.length} survivors before Opus scoring`);
          }

          sendProgress(`Merit-scoring ${meritPool.length} companies on 5 dimensions...`, 'meritscore', { total: meritPool.length });
          const MERIT_BATCH_SIZE = 7;  // Output budget: ~600 tokens × 7 = 4200, fits in 4096 with compression
          const meritBatches = Math.ceil(meritPool.length / MERIT_BATCH_SIZE);

          for (let bi = 0; bi < meritBatches; bi++) {
            if (isCancelled()) {
              clearInterval(keepAlive);
              console.log(`[Super] Cancelled during merit scoring (batch ${bi}/${meritBatches})`);
              return sendResult({ error: 'Cancelled by user', cancelled: true, signals: rated, totalSignals, sourceStats, anchorRatings, meritMode, partial: true });
            }
            const batch = meritPool.slice(bi * MERIT_BATCH_SIZE, (bi + 1) * MERIT_BATCH_SIZE);
            const profiles = batch.map(s => {
              const m = s.meta || {};
              const founders = m.founders || '';
              const fundingStr = m.funding ? '$' + (m.funding/1e6).toFixed(1) + 'M' : 'undisclosed';
              return `${s.title}
Funding: ${fundingStr} | Stage: ${m.stage || s.subtitle || '?'} | Headcount: ${m.headcount || '?'}
Founders: ${founders || 'unknown'}
Web: ${s.url || m.website || '—'}
Description: ${(s.text || '').slice(0, 500)}`;
            });

            const prompt = buildMeritPrompt({
              companies: profiles,
              anchorContext,
              additionalInfo: additionalInfo.slice(0, 6000),
              isAnchorSelfRating: false,
              anchorRatings,
            });

            sendProgress(`Merit batch ${bi + 1}/${meritBatches} — ${batch.length} companies`, 'meritscore', { batch: bi + 1, totalBatches: meritBatches });

            try {
              const opusRes = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
              });
              if (opusRes.ok) {
                const opusData = await opusRes.json();
                recordUsage('claude-opus-4-6', opusData.usage);
                const txt = opusData.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
                const m = txt.match(/```json\s*\n?([\s\S]*?)\n?```/);
                if (m) {
                  try {
                    const parsed = JSON.parse(m[1]);
                    for (const s of batch) {
                      const name = s.companyName || s.title || '';
                      const v = parsed[name]
                        || Object.entries(parsed).find(([k]) => k.toLowerCase().trim() === name.toLowerCase().trim())?.[1]
                        || Object.entries(parsed).find(([k]) => k.toLowerCase().includes(name.toLowerCase().slice(0, 12)))?.[1];
                      if (!v) continue;
                      const dims = {
                        pedigree: v.pedigree || 0, traction: v.traction || 0,
                        capital: v.capital || 0, investor: v.investor || 0, defensibility: v.defensibility || 0,
                      };
                      const weighted = computeWeightedScore(dims);
                      const modAdjust = applyModifiers(v.modifiers);
                      const rawFinal = Math.max(0, Math.min(10, weighted + modAdjust));

                      // Apply anchor sanity-check ceiling
                      let anchorRating = null;
                      if (s._anchor?.baseline) anchorRating = anchorRatings[s._anchor.baseline.toLowerCase()];
                      if (!anchorRating && Object.values(anchorRatings).length > 0) anchorRating = Object.values(anchorRatings)[0];
                      const ceilingResult = applyAnchorCeiling(dims, rawFinal, anchorRating);

                      s._merit = {
                        ...dims,
                        pedigree_reason: v.pedigree_reason || '',
                        traction_reason: v.traction_reason || '',
                        capital_reason: v.capital_reason || '',
                        investor_reason: v.investor_reason || '',
                        defensibility_reason: v.defensibility_reason || '',
                        modifiers: Array.isArray(v.modifiers) ? v.modifiers : [],
                        modifier_total: modAdjust,
                        weighted_raw: weighted,
                        bottom_line: v.bottom_line || '',
                        final: ceilingResult.final,
                        capped_to_anchor: ceilingResult.capped,
                        anchor_used: anchorRating ? Object.keys(anchorRatings).find(k => anchorRatings[k] === anchorRating) : null,
                      };
                      s._opusScore = ceilingResult.final;
                    }
                  } catch (e) { console.error(`[Super/Merit] Batch ${bi+1} JSON parse error:`, e.message); }
                }
              } else {
                console.error(`[Super/Merit] Batch ${bi+1} HTTP ${opusRes.status}`);
              }
            } catch (e) { console.error(`[Super/Merit] Batch ${bi+1} error:`, e.message); }
            if (bi + 1 < meritBatches) await sleep(300);
          }
          const meritCount = rated.filter(s => s._merit).length;
          console.log(`[Super/Merit] Scored ${meritCount} companies on 5 dimensions`);
          sendProgress(`Merit-scored ${meritCount} companies`, 'meritscore', { scored: meritCount });
        } else {
        // ── LEGACY OPUS PATH (no anchors — uses simple 1-10 scoring) ──
        // Build the candidate pool for Opus.
        // For Max/Extreme: guarantee Opus runs by filling up to opusTopN with top-engagement
        //   signals when HIGH/MEDIUM is short. User paid for deep scoring — give it to them.
        // For Deep (opus20): keep the strict HIGH/MEDIUM filter (lighter touch).
        let topForOpus;
        if (opusFillToN) {
          // Sort by signal priority then engagement, take top N
          const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
          const ordered = [...rated].sort((a, b) => {
            const sigDiff = (order[a.signal] || 2) - (order[b.signal] || 2);
            if (sigDiff !== 0) return sigDiff;
            return (b.engagement || 0) - (a.engagement || 0);
          });
          topForOpus = ordered.slice(0, opusTopN);
        } else {
          topForOpus = rated.filter(s => s.signal === 'HIGH' || s.signal === 'MEDIUM').slice(0, opusTopN);
        }
        console.log(`[Super] Opus pool: ${topForOpus.length} signals (tier=${superTier}, fillToN=${opusFillToN}, opusTopN=${opusTopN})`);
        if (topForOpus.length > 0) {
          sendProgress(`Deep scoring ${topForOpus.length} signals with Opus...`, 'deepscore', { total: topForOpus.length });
          const opusPrompt = `You are a senior deal partner at Daxos Capital evaluating Pre-Seed/Seed investments ($100K-$250K checks).
${anchorContext ? `\nSEARCH SCOPE — User asked for companies similar to these baselines. These define WHAT we searched for, NOT how to score:\n${anchorContext}\n⚠ CRITICAL: These signals are ALREADY filtered to be similar to the baselines. Similarity is a given — do NOT give similarity bonus points. Rate each company on its OWN investment merit.\nA company that is "very similar to a baseline rated 6.5" is NOT automatically a 9. Score on absolute investment quality, not relative similarity.\n` : ''}${additionalInfo ? `\nADDITIONAL CONTEXT FROM USER (apply to scoring — what to prioritize, avoid, or look for):\n${additionalInfo.slice(0, 12000)}\n` : ''}
SCORE 1-10 on INVESTMENT MERIT — the question is "would this be a good investment?" not "how similar is this to the baseline?"

We are looking for companies that are:
• LIKELY TO BE SUCCESSFUL — strong founders, real traction, clear path to scale
• GREAT PEDIGREE — repeat founder, prior exit, top-tier alumni, deep domain expertise
• GOOD IDEA — solving a real problem, sound business model
• NOVEL — differentiated angle, defensible moat, contrarian timing
• UNDERVALUED — overlooked at this stage, mispriced relative to traction

SCORING ANCHOR (be calibrated, not inflated):
- 9-10: Top 1-2% — exceptional founder + novel idea + real traction + right stage. Rare.
- 7-8: Top 10% — has 3 of {pedigree, idea, traction, undervalued}. Worth an intro call.
- 5-6: Average — competent execution but missing the standout factor. Generic similar-to-baseline lands here by default.
- 3-4: Weak — wrong stage, no traction, generic idea, or wrong fit
- 1-2: Pass — noise, mature company, fundamental issues

DEFAULT: most companies should land 4-6. Reserve 7+ for genuinely exceptional. A 9 means "I'd write the check now." Being similar to a baseline does NOT earn a 9 — it earns the right to be evaluated.

STEALTH COMPANIES: -3 score penalty unless founder has $10M+ prior exit + thesis fit.
Over-funded ($10M+): max score 6 unless extraordinary.

Respond with a JSON block, then 1-sentence reasoning per company. Reasoning must explain MERIT (founder, traction, idea, valuation), NOT similarity:
${'`'.repeat(3)}json
{"CompanyName": {"score": 6, "reason": "Solo founder ex-Stripe, $200K ARR at seed, defensible UX angle but crowded category."}, ...}
${'`'.repeat(3)}

SIGNALS TO SCORE:
${topForOpus.map((s, i) => `[${i+1}] ${s.companyName || s.title} (${s.source}) — ${s.text?.slice(0, 200)}`).join('\n')}`;

          try {
            const opusRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 4096, messages: [{ role: 'user', content: opusPrompt }] }),
            });
            if (opusRes.ok) {
              const opusData = await opusRes.json();
              recordUsage('claude-opus-4-6', opusData.usage);
              opusAnalysis = opusData.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
              try {
                const jsonMatch = opusAnalysis.match(/```json\s*\n?([\s\S]*?)\n?```/);
                if (jsonMatch) {
                  const opusScores = JSON.parse(jsonMatch[1]);
                  for (const s of rated) {
                    const name = s.companyName || s.title || '';
                    const match = opusScores[name] || Object.values(opusScores).find((v, i) => Object.keys(opusScores)[i].toLowerCase() === name.toLowerCase());
                    if (match?.score) { s._opusScore = match.score; s._opusReason = match.reason || ''; }
                  }
                  console.log(`[Super] Opus scored ${Object.keys(opusScores).length} companies`);
                }
              } catch (e) { console.error('[Super] Opus JSON parse error:', e.message); }
              cleanAnalysis += '\n\n## Opus Deep Analysis\n' + opusAnalysis.replace(/```json[\s\S]*?```\s*\n?/, '').trim();
              sendProgress(`Opus scored ${topForOpus.length} signals`, 'deepscore', {});
            }
          } catch (e) { console.error('[Super] Opus error:', e.message); }
        }
        }  // end legacy-Opus else branch
      }

      // Re-sort: Opus scores first (if available), then HIGH/MEDIUM/LOW
      rated.sort((a, b) => {
        if (a._opusScore && b._opusScore) return b._opusScore - a._opusScore;
        if (a._opusScore && !b._opusScore) return -1;
        if (!a._opusScore && b._opusScore) return 1;
        const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
        const sigDiff = (order[a.signal] || 2) - (order[b.signal] || 2);
        if (sigDiff !== 0) return sigDiff;
        return b.engagement - a.engagement;
      });

      // AUTO-PUSH HIGH signals to DD pipeline
      const hasHarmonic = sources.includes('harmonic') && sourceStats.harmonic > 0;
      const maxPush = hasHarmonic ? 15 : 5;
      const highSignals = rated.filter(s => s.signal === 'HIGH' && s.companyName);
      
      if (highSignals.length > 0) {
        try {
          const vettingData = loadVetting();
          const existingNames = new Set(vettingData.companies.map(c => (c.name || '').toLowerCase()));
          let pushed = 0;
          for (const sig of highSignals.slice(0, maxPush)) {
            const name = sig.companyName;
            if (!name || existingNames.has(name.toLowerCase())) continue;
            if (name.toLowerCase().startsWith('stealth company')) continue;
            existingNames.add(name.toLowerCase());
            vettingData.companies.push({
              name, description: sig.text?.slice(0, 300) || '', website: sig.url || null,
              source: `super-search:${hasHarmonic ? 'harmonic' : 'signals'}`,
              sourceMeta: { superSearchSource: sig.source, signalType: sig.signal, engagement: sig.engagement, scanDate: new Date().toISOString(), hasHarmonic },
              addedAt: Date.now(), votes: {}, dismissed: false,
            });
            pushed++;
          }
          if (pushed > 0) { saveVetting(vettingData); console.log(`[Super] Pushed ${pushed} HIGH to DD`); }
        } catch (e) { console.error('[Super] DD push error:', e.message); }
      }

      sendProgress('Done — preparing results...', 'done', {});
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const cost = computeCost();
      const estimatedCost = cost.total.toFixed(3);
      const opusRanCount = rated.filter(s => s._opusScore).length;
      console.log(`[Super] DONE — tier=${superTier} signals=${totalSignals} opusScored=${opusRanCount} cost=$${estimatedCost} (sonnet=$${cost.sonnet.toFixed(3)} opus=$${cost.opus.toFixed(3)} haiku=$${cost.haiku.toFixed(3)}) tokens=${JSON.stringify(usage)}`);
      return sendResult({
        signals: rated,
        analysis: cleanAnalysis,
        sourceStats,
        totalSignals,
        ddPushed: highSignals.slice(0, maxPush).length,
        elapsed,
        estimatedCost,
        costBreakdown: {
          total: cost.total,
          sonnet: cost.sonnet,
          opus: cost.opus,
          haiku: cost.haiku,
          tokens: usage,
        },
        tier: superTier,
        sourcesActual,
        sourcesSkipped,
        opusScoredCount: opusRanCount,
        meritMode,
        anchorRatings,
        fundingFilter: effectiveFundingFilter,
        meritScoredCount: rated.filter(s => s._merit).length,
      });
    }

    // Fallback: no Claude (no anthropicKey)
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    return sendResult({ signals: sorted.slice(0, 80), analysis: null, sourceStats, totalSignals, elapsed, estimatedCost: '0.00', sourcesActual, sourcesSkipped, tier: superTier });

  } catch (err) {
    console.error('[Super] Error:', err);
    sendResult({ signals: [], analysis: null, error: err.message });
  }
});

// ==========================================
// HARMONIC SAVED SEARCHES
// ==========================================

// List all saved searches from Harmonic
app.get('/api/harmonic/saved-searches', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'No Harmonic API key', searches: [] });

  try {
    const r = await fetch(`${HARMONIC_BASE}/savedSearches`, {
      headers: { apikey: harmonicKey },
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      console.error('[Harmonic] List saved searches failed:', r.status, err.slice(0, 200));
      return res.json({ error: `Harmonic API error: ${r.status}`, searches: [] });
    }
    const data = await r.json();
    // Normalize — could be array directly or { results: [...] }
    const searches = Array.isArray(data) ? data : (data.results || data.savedSearches || []);
    console.log('[Harmonic] Found', searches.length, 'saved searches');
    // Log all names and types for debugging
    searches.forEach((s, i) => {
      console.log(`[Harmonic] Search ${i + 1}: "${s.name || s.title || '?'}" type=${s.type || s.search_type || 'unknown'} id=${s.id || s.urn || '?'}`);
    });
    
    // Return simplified list — only company searches, not people/investor searches
    const companySearches = searches.filter(s => {
      const type = (s.type || s.search_type || '').toUpperCase();
      // Exclude known person types, keep everything else
      const isPersonSearch = type === 'PERSONS_LIST' || type === 'PERSONS' || type === 'PERSON' || type === 'PEOPLE';
      return !isPersonSearch;
    });
    console.log(`[Harmonic] Filtered to ${companySearches.length} company searches (from ${searches.length} total)`);
    
    const simplified = companySearches.map(s => ({
      id: s.id || s.urn,
      name: s.name || s.title || `Search ${s.id}`,
      type: s.type || s.search_type || 'company',
      count: s.count || s.resultCount || s.total || null,
      createdAt: s.created_at || s.createdAt || null,
      updatedAt: s.updated_at || s.updatedAt || null,
    }));
    
    res.json({ searches: simplified });
  } catch (e) {
    console.error('[Harmonic] Saved search list error:', e.message);
    res.json({ error: e.message, searches: [] });
  }
});

// Get results from a specific saved search
// Quick count of saved search results (no enrichment, just count)
app.get('/api/harmonic/saved-searches/count', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'No Harmonic API key', counts: {} });

  const ids = (req.query.ids || '').split(',').filter(Boolean);
  if (ids.length === 0) return res.json({ counts: {}, total: 0 });

  const counts = {};
  let total = 0;
  for (const id of ids) {
    try {
      const r = await fetch(`${HARMONIC_BASE}/savedSearches:results/${id}?size=1`, { headers: { apikey: harmonicKey } });
      if (r.ok) {
        const data = await r.json();
        const count = data.count || data.total || data.totalCount || (data.results || []).length || 0;
        counts[id] = count;
        total += count;
      }
    } catch (e) {}
  }
  res.json({ counts, total });
});

app.get('/api/harmonic/saved-searches/:id/results', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'No Harmonic API key', companies: [] });

  const searchId = req.params.id;
  const size = parseInt(req.query.size) || 50;
  const netNew = req.query.netNew === 'true';

  try {
    const endpoint = netNew
      ? `${HARMONIC_BASE}/savedSearches:netNewResults/${searchId}`
      : `${HARMONIC_BASE}/savedSearches:results/${searchId}`;
    
    const url = `${endpoint}?size=${size}`;
    console.log('[Harmonic] Fetching saved search results:', url);
    
    const r = await fetch(url, { headers: { apikey: harmonicKey } });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      console.error('[Harmonic] Saved search results failed:', r.status, err.slice(0, 200));
      return res.json({ error: `Harmonic API error: ${r.status}`, companies: [] });
    }
    
    const data = await r.json();
    const results = data.results || data.companies || [];
    console.log('[Harmonic] Saved search', searchId, 'returned', results.length, 'results');

    // Fetch full company details via GraphQL (Scout-quality)
    const companyIds = results.map(r => {
      if (r.id) return r.id;
      if (r.entity_urn) return r.entity_urn.split(':').pop();
      return null;
    }).filter(Boolean).slice(0, size);

    const hideIdx = buildUserHideIndex(resolvePersonId(req));

    // Drop backburned (+ per-user hidden) IDs before paying GQL enrichment cost
    let idsAfterBurn = companyIds.filter(id => !_backburnIdx.ids.has(String(id)));
    if (hideIdx) idsAfterBurn = idsAfterBurn.filter(id => !hideIdx.ids.has(String(id)));

    const enriched = await gqlEnrichCompanies(idsAfterBurn, harmonicKey);
    let companies = filterBackburn(enriched.map(c => gqlToCard(c)));
    companies = filterUserHidden(companies, hideIdx);

    res.json({
      companies,
      totalCount: data.count || results.length,
      searchId,
    });
  } catch (e) {
    console.error('[Harmonic] Saved search results error:', e.message);
    res.json({ error: e.message, companies: [] });
  }
});

// Start server
// ==========================================
// CREATE SAVED SEARCH (natural language → Harmonic saved search)
// ==========================================
app.post('/api/harmonic/saved-searches/create', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'No Harmonic API key' });

  const { name, keywords } = req.body;
  if (!name || !keywords) return res.status(400).json({ error: 'name and keywords required' });

  try {
    console.log(`[CreateSearch] Creating "${name}" with keywords: ${keywords.slice(0, 100)}`);
    const r = await fetch(`${HARMONIC_BASE}/savedSearches`, {
      method: 'POST',
      headers: { 'apikey': harmonicKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, keywords }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      console.error('[CreateSearch] Failed:', r.status, err.slice(0, 200));
      return res.json({ error: `Harmonic error: ${r.status}`, details: err.slice(0, 200) });
    }
    const data = await r.json();
    console.log('[CreateSearch] Created:', JSON.stringify(data).slice(0, 200));
    res.json({ success: true, savedSearch: data });
  } catch (e) {
    console.error('[CreateSearch] Error:', e.message);
    res.json({ error: e.message });
  }
});

// ==========================================
// ENHANCED SEARCH (NL + keywords + GQL enrichment)
// ==========================================
app.post('/api/harmonic/enhanced-search', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Guarded keepalive — without this, writing to a closed socket after client
  // disconnect can crash the Node process (no global uncaughtException handler).
  let _ssConnected = true;
  const keepAlive = setInterval(() => {
    if (!_ssConnected) return;
    try { res.write(': keepalive\n\n'); } catch (e) { _ssConnected = false; clearInterval(keepAlive); }
  }, 5000);
  req.on('close', () => { _ssConnected = false; clearInterval(keepAlive); });
  const sendResult = (data) => {
    clearInterval(keepAlive);
    if (_ssConnected) {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
      try { res.end(); } catch (e) {}
    }
  };

  const harmonicKey = req.headers['x-harmonic-key'] || process.env.HARMONIC_API_KEY;
  const anthropicKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;
  if (!harmonicKey) return sendResult({ error: 'Harmonic key required' });

  const { query, keywords, antiKeywords, size, saveName } = req.body;
  if (!query) return sendResult({ error: 'query required' });

  try {
    const maxSize = Math.min(parseInt(size) || 30, 100);
    console.log(`[EnhSearch] Query: "${query.slice(0, 60)}" size=${maxSize}`);

    // Run enhanced search
    let results = await enhancedSearch(query, harmonicKey, {
      size: maxSize,
      keywords: keywords || null,
      antiKeywords: antiKeywords || null,
    });
    results = filterBackburn(results);
    results = filterUserHidden(results, buildUserHideIndex(resolvePersonId(req)));

    // Optionally save as Harmonic saved search
    let savedSearchId = null;
    if (saveName) {
      try {
        const saveKeywords = keywords || query;
        const sr = await fetch(`${HARMONIC_BASE}/savedSearches`, {
          method: 'POST',
          headers: { 'apikey': harmonicKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: saveName, keywords: saveKeywords }),
        });
        if (sr.ok) {
          const sd = await sr.json();
          savedSearchId = sd.urn || sd.id;
          console.log(`[EnhSearch] Saved as "${saveName}" → ${savedSearchId}`);
        }
      } catch (e) { console.warn('[EnhSearch] Save failed:', e.message); }
    }

    // Claude analysis if available
    let analysis = null;
    if (anthropicKey && results.length > 0) {
      try {
        const companyText = results.slice(0, 15).map((c, i) => {
          const parts = [`${i+1}. ${c.name}`];
          if (c.description) parts.push(`   ${c.description.slice(0, 150)}`);
          if (c.funding_stage) parts.push(`   Stage: ${c.funding_stage}`);
          if (c.funding_total) parts.push(`   Raised: $${(c.funding_total/1e6).toFixed(1)}M`);
          if (c.founders?.length) parts.push(`   Founders: ${c.founders.map(f => f.name).join(', ')}`);
          if (c.traction?.webGrowth30d) parts.push(`   Web Growth 30d: ${c.traction.webGrowth30d}%`);
          if (c.highlights?.length) parts.push(`   Highlights: ${c.highlights.slice(0, 2).join('; ')}`);
          if (c.prior_companies?.length) parts.push(`   Leadership from: ${c.prior_companies.slice(0, 5).join(', ')}`);
          return parts.join('\n');
        }).join('\n\n');

        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1500,
            messages: [{ role: 'user', content: `User searched: "${query}"\n\nRate each company HIGH/MEDIUM/LOW signal for a pre-seed/seed VC fund. Consider traction metrics, founder pedigree, and sector fit.\n\nCompanies:\n${companyText}\n\nFor each, output: **CompanyName** — Signal: HIGH/MEDIUM/LOW — 1-sentence reason` }],
          }),
        });
        if (claudeRes.ok) {
          const cd = await claudeRes.json();
          analysis = cd.content?.filter(b => b.type === 'text').map(b => b.text).join('\n');

          // Parse signals
          const sigMap = {};
          for (const m of (analysis || '').matchAll(/\*\*([^*]+)\*\*.*?Signal:\s*(HIGH|MEDIUM|LOW)/gi)) {
            sigMap[m[1].trim().toLowerCase()] = m[2].toUpperCase();
          }
          // Apply signals to results
          results.forEach(r => { r.signal = sigMap[(r.name || '').toLowerCase()] || 'LOW'; });
          // Sort by signal
          const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
          results.sort((a, b) => (order[a.signal] || 2) - (order[b.signal] || 2));
        }
      } catch (e) { console.warn('[EnhSearch] Claude error:', e.message); }
    }

    sendResult({ results, analysis, savedSearchId, total: results.length });
  } catch (e) {
    console.error('[EnhSearch] Error:', e.message);
    sendResult({ error: e.message });
  }
});

// ==========================================
// AIRTABLE INTEGRATION
// ==========================================
const AIRTABLE_API = 'https://api.airtable.com/v0';
const AIRTABLE_TABLE = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'All Companies');

function airtableHeaders() {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) return null;
  return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// List all records from the CRM (optionally filter by CRM Stage)
app.get('/api/airtable/companies', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!headers || !baseId) return res.json({ error: 'Airtable not configured', companies: [] });

  const stage = req.query.stage || ''; // BO, BORO, BORO-SM, Warm, Backburn
  const maxRecords = parseInt(req.query.limit) || 100;

  try {
    let url = `${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?maxRecords=${maxRecords}`;
    if (stage) {
      const formula = encodeURIComponent(`{CRM Stage} = "${stage}"`);
      url += `&filterByFormula=${formula}`;
    }
    // Don't rely on Airtable sort — sort server-side after mapping dates

    console.log(`[Airtable] Fetching companies${stage ? ` (stage: ${stage})` : ''}`);
    const r = await fetch(url, { headers });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      console.error(`[Airtable] Error: ${r.status} ${err.slice(0, 200)}`);
      return res.json({ error: `Airtable error: ${r.status}`, companies: [] });
    }
    const data = await r.json();
    // Log first record's field names for debugging
    if (data.records?.length > 0) {
      const fieldNames = Object.keys(data.records[0].fields);
      console.log(`[Airtable] First record fields: ${fieldNames.join(', ')}`);
      console.log(`[Airtable] Last Modified Time: "${data.records[0].fields['Last Modified Time']}" | createdTime: "${data.records[0].createdTime}"`);
    }
    const companies = (data.records || []).map(rec => ({
      airtable_id: rec.id,
      created_time: rec.fields['Last Time CRM Stage Modified'] || rec.fields['Created'] || rec.createdTime || null,
      company: (rec.fields['Company'] || '').trim(),
      crm_stage: rec.fields['CRM Stage'] || '',
      in_or_out: rec.fields['IN or OUT'] || [],
      sector: rec.fields['Sector'] || '',
      source: rec.fields['Source'] || '',
      cb_link: rec.fields['CB Link'] || '',
      company_link: rec.fields['Company Link'] || '',
      twitter_link: rec.fields['Twitter Link'] || '',
      initial_rating: rec.fields['Initial Rating'] || null,
      total_funding: rec.fields['Total Funding'] || null,
      intro_call_notes: rec.fields['Intro Call Notes'] || '',
      notes: rec.fields['Original Notes + Ongoing Negotiation Notes'] || '',
      reachout_notes: rec.fields['Initial Reachout Notes'] || '',
      harmonic_id: rec.fields['Harmonic ID'] || null,
    }));
    // Sort by created_time (Last Time CRM Stage Modified) descending
    companies.sort((a, b) => new Date(b.created_time || 0).getTime() - new Date(a.created_time || 0).getTime());
    console.log(`[Airtable] Got ${companies.length} companies`);
    res.json({ companies, total: companies.length });
  } catch (e) {
    console.error('[Airtable] Error:', e.message);
    res.json({ error: e.message, companies: [] });
  }
});

// DEBUG: See raw Airtable fields for first record
app.get('/api/harmonic/debug-company', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'no key' });
  const name = req.query.name;
  if (!name) return res.json({ error: 'name required' });
  try {
    const tr = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(name)}&size=5`, { headers: { apikey: harmonicKey } });
    const td = await tr.json();
    // Return the RAW typeahead so we can see all fields
    const rawTypeahead = (td.results || []).slice(0, 5);
    // Try to fetch the first company entity by URN
    let full = null;
    const first = (td.results || []).find(r => /company:/.test(r.entity_urn || ''));
    if (first) {
      const tid = (first.entity_urn || '').split(':').pop();
      if (tid) {
        const cr = await fetch(`${HARMONIC_BASE}/companies/${tid}`, { headers: { apikey: harmonicKey } });
        if (cr.ok) full = await cr.json();
      }
    }
    res.json({ rawTypeahead, full });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/airtable/debug-fields', async (req, res) => {
  const headers = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!headers || !baseId) return res.json({ error: 'Not configured' });
  try {
    const stage = req.query.stage || 'BO';
    const formula = encodeURIComponent(`{CRM Stage} = "${stage}"`);
    const url = `${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?maxRecords=1&filterByFormula=${formula}`;
    const r = await fetch(url, { headers });
    const data = await r.json();
    const rec = data.records?.[0];
    if (!rec) return res.json({ error: 'No records found' });
    res.json({ id: rec.id, createdTime: rec.createdTime, fieldNames: Object.keys(rec.fields), fields: rec.fields });
  } catch (e) { res.json({ error: e.message }); }
});

// GET /api/airtable/reachout-notes?company=CompanyName
app.get('/api/airtable/reachout-notes', async (req, res) => {
  try {
    const company = req.query.company;
    if (!company) return res.status(400).json({ error: 'company required' });

    const baseId = process.env.AIRTABLE_BASE_ID;
    const tableName = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'All Companies');
    const formula = encodeURIComponent(`{Company} = "${company.replace(/"/g, '\\"')}"`);

    const resp = await fetch(
      `https://api.airtable.com/v0/${baseId}/${tableName}?filterByFormula=${formula}&maxRecords=1`,
      { headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` } }
    );
    const data = await resp.json();
    const record = data.records?.[0];

    res.json({
      company: company,
      reachoutNotes: record?.fields?.['Initial Reachout Notes'] || record?.fields?.['initial reachout notes'] || '',
      airtable_id: record?.id || null
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Detect URLs that are clearly NOT a company website — social posts, tweet/cast/repo
// permalinks, news article paths, etc. These get passed into /add by signal cards
// because the card's "source URL" field gets reused as `website`. Harmonic's domain
// is always preferred over one of these.
function looksLikeSourceUrl(url) {
  if (!url) return false;
  const u = String(url).toLowerCase();
  // Known source-only hosts (post permalinks, not company sites)
  if (/^https?:\/\/(www\.)?(x|twitter)\.com\//.test(u)) return true;
  if (/^https?:\/\/(www\.)?warpcast\.com\//.test(u)) return true;
  if (/^https?:\/\/(www\.)?farcaster\.xyz\//.test(u)) return true;
  if (/^https?:\/\/(www\.)?producthunt\.com\//.test(u)) return true;
  if (/^https?:\/\/(www\.)?reddit\.com\//.test(u)) return true;
  if (/^https?:\/\/(www\.)?linkedin\.com\/posts\//.test(u)) return true;
  if (/^https?:\/\/(www\.)?medium\.com\//.test(u)) return true;
  if (/^https?:\/\/(www\.)?substack\.com\//.test(u)) return true;
  // GitHub repo URLs (path beyond the org/) — a company's own github org is fine,
  // but `github.com/foo/bar` (repo) is not a company site.
  if (/^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/?#]+/.test(u)) return true;
  // Permalink-shaped paths on any domain
  if (/\/(status|posts|p|cast|notes|comments)\/[^/]+/.test(u)) return true;
  return false;
}

// Add a company to Airtable CRM (with auto-enrichment from Harmonic)
app.post('/api/airtable/add', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!headers || !baseId) return res.json({ error: 'Airtable not configured' });

  const { company, stage, sector, source, website, twitter, crunchbase, funding, rating, notes, addedBy } = req.body;
  if (!company) return res.status(400).json({ error: 'company name required' });

  // Start with provided data
  let enrichedWebsite = website || '';
  let enrichedTwitter = twitter || '';
  let enrichedCB = crunchbase || '';
  let enrichedFunding = funding || null;
  let enrichedSector = sector || '';
  let enrichedDescription = notes || '';
  let harmonicData = null;

  // Auto-enrich from Harmonic if we have the key
  if (harmonicKey) {
    try {
      console.log(`[Airtable+Harmonic] Enriching "${company}" before adding...`);

      // Try domain lookup first if we have a website
      if (enrichedWebsite) {
        const domain = enrichedWebsite.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
        if (domain) {
          const dr = await fetch(`${HARMONIC_BASE}/companies?website_domain=${encodeURIComponent(domain)}`, { headers: { apikey: harmonicKey } });
          if (dr.ok) {
            const dd = await dr.json();
            if (dd.id) harmonicData = dd;
          }
        }
      }

      // Fallback to typeahead
      if (!harmonicData) {
        const tr = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(company)}&size=3`, { headers: { apikey: harmonicKey } });
        if (tr.ok) {
          const td = await tr.json();
          const results = td.results || [];
          const compLower2 = company.toLowerCase().trim();
          const exact = results.find(r => (r.name || '').toLowerCase().trim() === compLower2);
          let target = exact;
          if (!target && results[0]) {
            // Fuzzy: only use results[0] if name has significant word overlap
            const cw = compLower2.split(/\s+/);
            const rw = (results[0].name || '').toLowerCase().split(/\s+/);
            const ov = cw.filter(w => rw.some(r2 => r2.includes(w) || w.includes(r2))).length;
            if (ov / Math.max(cw.length, 1) >= 0.4) target = results[0];
            else console.log(`[Add/Enrich] Rejected typeahead "${results[0].name}" for "${company}" — low overlap`);
          }
          if (target) {
            const tid = target.id || (target.entity_urn || '').split(':').pop();
            if (tid) {
              const cr = await fetch(`${HARMONIC_BASE}/companies/${tid}`, { headers: { apikey: harmonicKey } });
              if (cr.ok) harmonicData = await cr.json();
            }
          }
        }
      }

      if (harmonicData) {
        const c = harmonicData;
        const f = c.funding || {};
        console.log(`[Airtable+Harmonic] Found: ${c.name} (ID: ${c.id})`);

        // Harmonic's website is authoritative — overwrite any passed-in value
        // (signal.url from Twitter/GitHub/PH/Farcaster is a SOURCE post URL, not the company domain).
        const harmonicWebsite = c.website?.url || c.website?.domain || '';
        if (harmonicWebsite && (!enrichedWebsite || looksLikeSourceUrl(enrichedWebsite))) {
          if (enrichedWebsite && enrichedWebsite !== harmonicWebsite) {
            console.log(`[Airtable+Harmonic] Replacing source-URL "${enrichedWebsite}" with Harmonic domain "${harmonicWebsite}"`);
          }
          enrichedWebsite = harmonicWebsite;
        }
        if (!enrichedTwitter) enrichedTwitter = c.socials?.twitter?.url || '';
        if (!enrichedCB) enrichedCB = c.socials?.crunchbase?.url || '';
        if (!enrichedFunding) {
          const ft = f.funding_total || f.fundingTotal;
          if (ft) enrichedFunding = ft;
        }
        if (!enrichedSector) {
          const tags = (c.tagsV2 || c.tags || []).map(t => t.displayValue || t.tag_value || '').filter(Boolean);
          if (tags.length) enrichedSector = tags.slice(0, 3).join(', ');
        }
        // Build a rich description
        const parts = [];
        if (c.description || c.short_description) parts.push((c.description || c.short_description).slice(0, 200));
        const fundStage = f.funding_stage || f.lastFundingType || c.stage;
        if (fundStage) parts.push(`Stage: ${fundStage}`);
        const ft2 = f.funding_total || f.fundingTotal;
        if (ft2) parts.push(`Raised: $${ft2 >= 1e6 ? (ft2/1e6).toFixed(1)+'M' : (ft2/1e3).toFixed(0)+'K'}`);
        if (c.headcount) parts.push(`Team: ${c.headcount}`);
        const loc = c.location ? [c.location.city, c.location.state, c.location.country].filter(Boolean).join(', ') : '';
        if (loc) parts.push(`Location: ${loc}`);
        if (parts.length && !enrichedDescription) enrichedDescription = `${parts.join(' · ')}`;

        console.log(`[Airtable+Harmonic] Enriched: website=${!!enrichedWebsite}, twitter=${!!enrichedTwitter}, cb=${!!enrichedCB}, funding=${enrichedFunding}`);
      }
    } catch (e) {
      console.warn(`[Airtable+Harmonic] Enrichment failed:`, e.message);
    }
  }

  // Build Airtable fields
  const fields = {
    'Company': company,
    'CRM Stage': stage || 'BO',
  };
  if (enrichedSector) fields['Sector'] = enrichedSector;
  fields['Source'] = source || 'Pigeon Finder';
  if (enrichedWebsite) fields['Company Link'] = enrichedWebsite.startsWith('http') ? enrichedWebsite : `https://${enrichedWebsite}`;
  if (enrichedTwitter) fields['Twitter Link'] = enrichedTwitter.startsWith('http') ? enrichedTwitter : `https://x.com/${enrichedTwitter}`;
  if (enrichedCB) fields['CB Link'] = enrichedCB;
  if (enrichedFunding) {
    const ftNum = typeof enrichedFunding === 'number' ? enrichedFunding : parseFloat(enrichedFunding);
    if (ftNum >= 1e9) fields['Total Funding'] = `$${(ftNum/1e9).toFixed(1)}B`;
    else if (ftNum >= 1e6) fields['Total Funding'] = `$${(ftNum/1e6).toFixed(1)}M`;
    else if (ftNum >= 1e3) fields['Total Funding'] = `$${(ftNum/1e3).toFixed(0)}K`;
    else if (ftNum > 0) fields['Total Funding'] = `$${ftNum}`;
  }
  if (rating) fields['Initial Rating'] = typeof rating === 'number' ? rating : parseInt(rating) || null;
  if (enrichedDescription) fields['Original Notes + Ongoing Negotiation Notes'] = enrichedDescription;
  const NO_AUTO_VOTE = ['Serena']; // Users who don't auto-vote on add
  if (addedBy) {
    fields['Source'] = `Pigeon Finder (${addedBy})`;
    // Auto-vote IN for the person who added it (except no-auto-vote users)
    if (!NO_AUTO_VOTE.includes(addedBy)) {
      const voterMap = { 'Joe': 'Joe C', 'Mark': 'Mark', 'Carlo': 'Carlo', 'Jake': 'Jake', 'Liam': 'Liam' };
      const airtableVoter = voterMap[addedBy] || addedBy;
      fields['IN or OUT'] = [`${airtableVoter}: IN`];
    }
  }

  try {
    // Check if company already exists — by Company name OR by Harmonic ID.
    // Name-only check was missing the duplicate-from-race case (two near-simultaneous
    // /add calls would both pass the name check and both insert). Adding the Harmonic
    // ID OR-clause catches the same company even if the name had a typo difference.
    const hid = (harmonicData && harmonicData.id) ? String(harmonicData.id) : null;
    const safeCo = company.replace(/"/g, '\\"');
    const checkFormula = encodeURIComponent(
      hid
        ? `OR({Company} = "${safeCo}", {Harmonic ID} = "${hid}")`
        : `{Company} = "${safeCo}"`
    );
    const checkUrl = `${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${checkFormula}&maxRecords=5`;
    const checkRes = await fetch(checkUrl, { headers });
    if (checkRes.ok) {
      const checkData = await checkRes.json();
      if (checkData.records?.length > 0) {
        // Prefer richest record when name and harmonic-id matched different rows.
        const recs = checkData.records;
        if (recs.length > 1) {
          const score = (r2) => {
            const f = r2.fields || {};
            return (Array.isArray(f['IN or OUT']) ? f['IN or OUT'].length * 10 : 0)
              + (f['Harmonic ID'] ? 5 : 0) + (f['Initial Rating'] ? 3 : 0)
              + (f['Initial Reachout Notes'] ? 2 : 0) + (f['Total Funding'] ? 1 : 0);
          };
          recs.sort((a, b) => score(b) - score(a));
          console.warn(`[Airtable/add] DUPLICATE: ${recs.length} records for "${company}" — updating richest (${recs[0].id})`);
        }
        const existing = recs[0];
        // Update stage + fill in any missing fields
        const updateFields = { 'CRM Stage': stage || existing.fields['CRM Stage'] };
        // Overwrite Company Link when (a) existing is empty, or (b) existing is a known source-URL
        // shape (twitter/x/warpcast/etc.) — Harmonic's domain is always more trustworthy than a
        // tweet permalink that landed in the field via a signal-card add.
        const existingLink = existing.fields['Company Link'] || '';
        if (enrichedWebsite && fields['Company Link'] && (!existingLink || looksLikeSourceUrl(existingLink))) {
          if (existingLink && existingLink !== fields['Company Link']) {
            console.log(`[Airtable] Healing "${company}" Company Link: "${existingLink}" → "${fields['Company Link']}"`);
          }
          updateFields['Company Link'] = fields['Company Link'];
        }
        if (!existing.fields['Twitter Link'] && enrichedTwitter) updateFields['Twitter Link'] = fields['Twitter Link'];
        if (!existing.fields['CB Link'] && enrichedCB) updateFields['CB Link'] = fields['CB Link'];
        if (!existing.fields['Total Funding'] && enrichedFunding) updateFields['Total Funding'] = fields['Total Funding'];
        
        // Add IN vote for the person adding, preserving existing votes
        if (addedBy && !NO_AUTO_VOTE.includes(addedBy)) {
          const voterMap2 = { 'Joe': 'Joe C', 'Mark': 'Mark', 'Carlo': 'Carlo', 'Jake': 'Jake', 'Liam': 'Liam' };
          const av = voterMap2[addedBy] || addedBy;
          const existingVotes = existing.fields['IN or OUT'] || [];
          const voteKey = `${av}: IN`;
          const outKey = `${av}: OUT`;
          if (!existingVotes.includes(voteKey)) {
            const newVotes = existingVotes.filter(v => v !== outKey);
            newVotes.push(voteKey);
            updateFields['IN or OUT'] = newVotes;
          }
        }
        
        const patchRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${existing.id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ fields: updateFields }),
        });
        if (!patchRes.ok) {
          const patchErr = await patchRes.text().catch(() => '');
          console.error(`[Airtable] Update error: ${patchRes.status} ${patchErr.slice(0, 300)}`);
          console.error(`[Airtable] Update fields attempted:`, JSON.stringify(updateFields));
          return res.json({ error: `Airtable error: ${patchRes.status}`, details: patchErr.slice(0, 300) });
        }
        console.log(`[Airtable] Updated "${company}" → ${stage}, filled ${Object.keys(updateFields).length} fields`);
        return res.json({ success: true, action: 'updated', stage: stage || existing.fields['CRM Stage'], airtable_id: existing.id, fieldsUpdated: Object.keys(updateFields) });
      }
    }

    // Create new record
    console.log(`[Airtable] Adding "${company}" to ${stage || 'BO'} with ${Object.keys(fields).length} fields:`, Object.keys(fields).join(', '));
    let r = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}`, {
      method: 'POST', headers,
      body: JSON.stringify({ records: [{ fields }] }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      console.error(`[Airtable] Create error: ${r.status} ${err.slice(0, 500)}`);
      console.error(`[Airtable] Fields attempted:`, JSON.stringify(fields).slice(0, 500));
      
      // Retry with just the safe fields (name + stage + links)
      if (r.status === 422) {
        console.log(`[Airtable] Retrying with minimal fields...`);
        const safeFields = { 'Company': fields['Company'], 'CRM Stage': fields['CRM Stage'] };
        if (fields['Company Link']) safeFields['Company Link'] = fields['Company Link'];
        if (fields['Twitter Link']) safeFields['Twitter Link'] = fields['Twitter Link'];
        if (fields['Source']) safeFields['Source'] = fields['Source'];
        
        r = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}`, {
          method: 'POST', headers,
          body: JSON.stringify({ records: [{ fields: safeFields }] }),
        });
        if (!r.ok) {
          const err2 = await r.text().catch(() => '');
          console.error(`[Airtable] Retry also failed: ${r.status} ${err2.slice(0, 200)}`);
          return res.json({ error: `Airtable error: ${r.status}`, details: err2.slice(0, 300) });
        }
        const data = await r.json();
        const newId = data.records?.[0]?.id;
        console.log(`[Airtable] Created "${company}" with minimal fields → ${newId}`);
        return res.json({ success: true, action: 'created', stage: stage || 'BO', airtable_id: newId, fieldsPopulated: Object.keys(safeFields), note: 'Some fields skipped due to type mismatch' });
      }
      return res.json({ error: `Airtable error: ${r.status}`, details: err.slice(0, 300) });
    }
    const data = await r.json();
    const newId = data.records?.[0]?.id;
    console.log(`[Airtable] Created "${company}" → ${newId} with fields: ${Object.keys(fields).join(', ')}`);
    res.json({ success: true, action: 'created', stage: stage || 'BO', airtable_id: newId, fieldsPopulated: Object.keys(fields) });
  } catch (e) {
    console.error('[Airtable] Error:', e.message);
    res.json({ error: e.message });
  }
});

// Heal: find every CRM record whose Company Link is a source-shaped URL (tweet,
// cast, repo, blog post) and replace it with the real domain from Harmonic.
// Call with ?apply=true to actually patch; otherwise returns a dry-run diff.
app.post('/api/airtable/heal-websites', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!headers || !baseId) return res.json({ error: 'Airtable not configured' });
  if (!harmonicKey) return res.json({ error: 'Harmonic key not configured' });
  const apply = String(req.query.apply || req.body?.apply || '') === 'true';
  // mode=strict (default): only flag source-shaped URLs (tweets, casts, etc.)
  // mode=mismatch: ALSO flag plain domains that disagree with Harmonic's exact-name match
  // stages: limit to specific CRM stages (comma-separated, default = all)
  // name: limit to a single company name (case-insensitive, verbose diagnostics)
  const mode = String(req.query.mode || req.body?.mode || 'strict');
  const stagesFilter = (req.query.stages || req.body?.stages || '').split(',').map(s => s.trim()).filter(Boolean);
  const nameFilter = String(req.query.name || req.body?.name || '').toLowerCase().trim();
  const verbose = !!nameFilter || String(req.query.verbose || '') === 'true';
  const diag = [];

  const apex = (u) => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split(':')[0];

  try {
    const proposals = [];
    let offset = null;
    let scanned = 0;
    do {
      const url = new URL(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}`);
      url.searchParams.set('pageSize', '100');
      url.searchParams.set('fields[]', 'Company');
      url.searchParams.append('fields[]', 'Company Link');
      url.searchParams.append('fields[]', 'Harmonic ID');
      url.searchParams.append('fields[]', 'CRM Stage');
      if (offset) url.searchParams.set('offset', offset);
      const r = await fetch(url, { headers });
      if (!r.ok) return res.json({ error: `Airtable list error ${r.status}` });
      const data = await r.json();
      for (const rec of data.records || []) {
        scanned++;
        const link = rec.fields['Company Link'] || '';
        const name = rec.fields['Company'] || '';
        const stage = rec.fields['CRM Stage'] || '';
        if (stagesFilter.length && !stagesFilter.includes(stage)) continue;
        if (nameFilter && name.toLowerCase().trim() !== nameFilter) continue;
        const isSourceShape = looksLikeSourceUrl(link);
        // In strict mode skip anything that doesn't look like a source URL
        if (mode === 'strict' && !isSourceShape) { if (verbose) diag.push({ company: name, skip: 'not_source_shape', link }); continue; }
        // In mismatch mode also process plain domains (we'll compare to Harmonic later)
        const hid = rec.fields['Harmonic ID'] || '';
        let real = '';
        let matchKind = '';
        if (hid) {
          const cr = await fetch(`${HARMONIC_BASE}/companies/${hid}`, { headers: { apikey: harmonicKey } });
          if (cr.ok) { const cd = await cr.json(); real = cd.website?.url || cd.website?.domain || ''; matchKind = 'harmonic_id'; }
        }
        if (!real && name) {
          const tr = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(name)}&size=3`, { headers: { apikey: harmonicKey } });
          if (tr.ok) {
            const td = await tr.json();
            const exact = (td.results || []).find(r => (r.name || '').toLowerCase().trim() === name.toLowerCase().trim());
            const target = exact || (mode !== 'mismatch' ? (td.results || [])[0] : null); // mismatch mode requires EXACT name match
            if (target) {
              matchKind = exact ? 'name_exact' : 'name_fuzzy';
              const tid = target.id || (target.entity_urn || '').split(':').pop();
              if (tid) {
                const cr = await fetch(`${HARMONIC_BASE}/companies/${tid}`, { headers: { apikey: harmonicKey } });
                if (cr.ok) { const cd = await cr.json(); real = cd.website?.url || cd.website?.domain || ''; }
              }
            }
          }
        }
        if (!real) { if (verbose) diag.push({ company: name, skip: 'harmonic_no_website', hid, matchKind }); continue; }
        const realUrl = real.startsWith('http') ? real : `https://${real}`;
        if (apex(realUrl) === apex(link)) { if (verbose) diag.push({ company: name, skip: 'already_correct', link, realUrl }); continue; }
        // In mismatch mode, only flag plain-domain replacements when Harmonic match was high-confidence
        if (mode === 'mismatch' && !isSourceShape) {
          if (matchKind !== 'harmonic_id' && matchKind !== 'name_exact') { if (verbose) diag.push({ company: name, skip: 'low_confidence_match', matchKind, real }); continue; }
        }
        proposals.push({ id: rec.id, company: name, stage, from: link, to: realUrl, match: matchKind, source_shape: isSourceShape });
        if (apply) {
          const patch = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${rec.id}`, {
            method: 'PATCH', headers, body: JSON.stringify({ fields: { 'Company Link': realUrl } }),
          });
          if (!patch.ok) console.error(`[Heal] PATCH failed for ${name}: ${patch.status}`);
        }
      }
      offset = data.offset || null;
    } while (offset);
    res.json({ scanned, mode, stages: stagesFilter, proposals, applied: apply, count: proposals.length, ...(verbose ? { diagnostics: diag } : {}) });
  } catch (e) {
    console.error('[Heal] error:', e.message);
    res.json({ error: e.message });
  }
});

// Update a specific field on a company record
app.post('/api/airtable/update-field', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!headers || !baseId) return res.json({ error: 'Airtable not configured' });

  const { airtable_id, field, value } = req.body;
  if (!airtable_id || !field) return res.status(400).json({ error: 'airtable_id and field required' });

  // Map frontend field names to Airtable column names
  const fieldMap = {
    'company': 'Company',
    'crm_stage': 'CRM Stage',
    'sector': 'Sector',
    'source': 'Source',
    'company_link': 'Company Link',
    'twitter_link': 'Twitter Link',
    'cb_link': 'CB Link',
    'total_funding': 'Total Funding',
    'initial_rating': 'Initial Rating',
    'intro_call_notes': 'Intro Call Notes',
  };

  const airtableField = fieldMap[field] || field;
  console.log(`[Airtable] Updating ${airtable_id}: ${airtableField} = ${String(value).slice(0, 50)}`);

  try {
    const r = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${airtable_id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ fields: { [airtableField]: value } }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      return res.json({ error: `Update failed: ${r.status}`, details: err.slice(0, 200) });
    }
    res.json({ success: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Update a company's CRM Stage
app.post('/api/airtable/update-stage', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!headers || !baseId) return res.json({ error: 'Airtable not configured' });

  const { company, stage, airtable_id } = req.body;
  if (!company || !stage) return res.status(400).json({ error: 'company and stage required' });

  try {
    console.log(`[Airtable] Stage change: "${company}" → ${stage}${airtable_id ? ' (id: ' + airtable_id + ')' : ''}`);
    let record = null;

    // PREFERRED: direct fetch by airtable_id — avoids hitting the wrong duplicate.
    if (airtable_id) {
      const directRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${airtable_id}`, { headers });
      if (directRes.ok) record = await directRes.json();
      else console.warn(`[Airtable] Stage direct fetch ${airtable_id} failed: ${directRes.status} — falling back to name search`);
    }

    // FALLBACK: name search. Prefer richest record when duplicates exist.
    if (!record) {
      const formula = encodeURIComponent(`{Company} = "${company.replace(/"/g, '\\"')}"`);
      const r = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${formula}&maxRecords=10`, { headers });
      if (!r.ok) return res.json({ error: `Airtable error: ${r.status}` });
      const data = await r.json();
      const matches = data.records || [];
      if (matches.length > 1) {
        const score = (r2) => {
          const f = r2.fields || {};
          return (Array.isArray(f['IN or OUT']) ? f['IN or OUT'].length * 10 : 0)
            + (f['Harmonic ID'] ? 5 : 0) + (f['Initial Rating'] ? 3 : 0)
            + (f['Initial Reachout Notes'] ? 2 : 0) + (f['Total Funding'] ? 1 : 0);
        };
        matches.sort((a, b) => score(b) - score(a));
        console.warn(`[Airtable] DUPLICATE: ${matches.length} records for "${company}" — updating richest (${matches[0].id})`);
      }
      record = matches[0];

      if (!record) {
        const sf = encodeURIComponent(`SEARCH("${company.replace(/"/g, '\\"')}", {Company})`);
        const sr = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${sf}&maxRecords=5`, { headers });
        if (sr.ok) {
          const sd = await sr.json();
          record = (sd.records || []).find(rec => (rec.fields['Company'] || '').trim() === company);
        }
      }
    }

    if (!record) return res.json({ error: 'Company not found in Airtable' });

    const recId = record.id;
    const ur = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${recId}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ fields: { 'CRM Stage': stage } }),
    });
    if (!ur.ok) return res.json({ error: `Update error: ${ur.status}` });
    console.log(`[Airtable] Updated "${company}" → ${stage}`);
    // Backburn-aware: warm the in-memory index instantly when a company moves into Backburn.
    // Out-of-Backburn moves are caught by the 5-min periodic refresh — acceptable lag for a rare action.
    if (stage === 'Backburn') {
      addToBackburnIndex({ name: company, website: record.fields?.['Company Link'] || '', harmonic_id: record.fields?.['Harmonic ID'] || null });
      setImmediate(() => { refreshBackburnIndex().catch(() => {}); });
    }
    res.json({ success: true, company, stage });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ───────── DEDUPE Airtable records (Company name collisions) ─────────
// Finds duplicate rows in Airtable, merges votes/data into the richest, deletes the rest.
// Optional `dryRun: true` returns the plan without mutating.
app.post('/api/airtable/dedupe', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const hdrs = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!hdrs || !baseId) return res.json({ error: 'Airtable not configured' });
  const dryRun = !!req.body?.dryRun;

  try {
    // Pull every record (paginated)
    const all = [];
    let offset = null, pages = 0;
    do {
      let url = `${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?pageSize=100`;
      if (offset) url += `&offset=${encodeURIComponent(offset)}`;
      const r = await fetch(url, { headers: hdrs });
      if (!r.ok) return res.json({ error: `Airtable list error: ${r.status}` });
      const d = await r.json();
      all.push(...(d.records || []));
      offset = d.offset || null;
      pages++;
      if (pages > 25) break; // safety
    } while (offset);

    // Group by lowercase Company name
    const groups = {};
    for (const r of all) {
      const name = ((r.fields || {}).Company || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      (groups[key] ||= []).push(r);
    }
    const dupGroups = Object.entries(groups).filter(([, arr]) => arr.length > 1);

    const score = (r2) => {
      const f = r2.fields || {};
      return (Array.isArray(f['IN or OUT']) ? f['IN or OUT'].length * 10 : 0)
        + (f['Harmonic ID'] ? 5 : 0) + (f['Initial Rating'] ? 3 : 0)
        + (f['Initial Reachout Notes'] ? 2 : 0) + (f['Total Funding'] ? 1 : 0)
        + (f['Original Notes + Ongoing Negotiation Notes'] ? 1 : 0);
    };

    // Fields we'll merge: union for arrays (votes!), prefer non-empty for scalars.
    // This way, even when records have EQUAL scores, no data is lost — votes from
    // the deleted record get unioned into the keeper's votes.
    const SCALAR_FIELDS = ['Company Link', 'Twitter Link', 'CB Link', 'Harmonic ID', 'Total Funding', 'Initial Rating', 'Sector', 'Source', 'Initial Reachout Notes', 'Original Notes + Ongoing Negotiation Notes', 'Intro Call Notes'];

    const plan = [];
    let deleted = 0, merged = 0;
    for (const [key, recs] of dupGroups) {
      recs.sort((a, b) => score(b) - score(a));
      const keep = recs[0];
      const toDelete = recs.slice(1);

      // Union votes across all records into the keeper.
      const keepFields = keep.fields || {};
      const allVotes = new Set(Array.isArray(keepFields['IN or OUT']) ? keepFields['IN or OUT'] : []);
      const mergeUpdates = {};
      for (const r of toDelete) {
        const f = r.fields || {};
        if (Array.isArray(f['IN or OUT'])) {
          for (const v of f['IN or OUT']) allVotes.add(v);
        }
        for (const sf of SCALAR_FIELDS) {
          if (!keepFields[sf] && f[sf] && !mergeUpdates[sf]) mergeUpdates[sf] = f[sf];
        }
      }
      const keeperVotesBefore = (keepFields['IN or OUT'] || []).length;
      if (allVotes.size > keeperVotesBefore) mergeUpdates['IN or OUT'] = [...allVotes];

      // Promote keeper's stage to the highest ACTIVE stage among dupes.
      // Only promote within the known good-deal pipeline. Backburn / unknown stages
      // ('Issues Contacting', 'Not Imported To CRM', etc.) are NOT targets — only
      // keep them if the keeper is already there. And never promote OUT of Backburn.
      const STAGE_RANK = { 'BORO-SM': 5, 'BORO': 4, 'BO': 3, 'Warm': 2 };
      const keepStage = keepFields['CRM Stage'] || '';
      let bestStage = keepStage;
      let bestRank = STAGE_RANK[keepStage] || 0;
      const keeperIsBackburn = keepStage === 'Backburn';
      for (const r of toDelete) {
        const s = (r.fields || {})['CRM Stage'] || '';
        const rank = STAGE_RANK[s] || 0;
        // Only promote to a stage that exists in the rank table (skips Backburn/unknown).
        // Never auto-promote OUT of Backburn.
        if (rank > 0 && rank > bestRank && !keeperIsBackburn) { bestStage = s; bestRank = rank; }
      }
      if (bestStage !== keepStage) mergeUpdates['CRM Stage'] = bestStage;

      plan.push({
        name: keep.fields.Company,
        keep: keep.id,
        keepScore: score(keep),
        delete: toDelete.map(r => ({ id: r.id, score: score(r) })),
        votesUnioned: [...allVotes],
        votesBefore: keeperVotesBefore,
        votesAfter: allVotes.size,
        fieldsBackfilled: Object.keys(mergeUpdates).filter(k => k !== 'IN or OUT' && k !== 'CRM Stage'),
        stageChange: mergeUpdates['CRM Stage'] ? `${keepStage} → ${mergeUpdates['CRM Stage']}` : null,
      });

      if (!dryRun) {
        // 1. PATCH the keeper with merged data
        if (Object.keys(mergeUpdates).length > 0) {
          try {
            const mr = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${keep.id}`, {
              method: 'PATCH', headers: hdrs,
              body: JSON.stringify({ fields: mergeUpdates }),
            });
            if (mr.ok) merged++;
            else console.error(`[Dedupe] merge PATCH failed for ${keep.id}: ${mr.status}`);
          } catch (e) { console.error('[Dedupe] merge error:', e.message); }
        }
        // 2. DELETE the duplicates
        for (const r of toDelete) {
          try {
            const dr = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${r.id}`, { method: 'DELETE', headers: hdrs });
            if (dr.ok) deleted++;
          } catch (e) { console.error('[Dedupe] delete failed:', r.id, e.message); }
        }
      }
    }

    res.json({
      success: true,
      dryRun,
      totalRecords: all.length,
      duplicateGroups: dupGroups.length,
      merged: dryRun ? 0 : merged,
      deleted: dryRun ? 0 : deleted,
      plan,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Enrich Airtable companies with Harmonic data
app.post('/api/airtable/enrich', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!headers || !baseId) return res.json({ error: 'Airtable not configured' });
  if (!harmonicKey) return res.json({ error: 'Harmonic not configured' });

  const { company, airtable_id, website, twitter, preview } = req.body;
  if (!company) return res.status(400).json({ error: 'company required' });

  try {
    let targetId = null;

    // Typeahead — try domain name first (more specific), then company name
    if (!targetId) {
      const enrichDomain = (website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
      const enrichDomainBase = enrichDomain ? enrichDomain.split('.')[0] : '';
      const queries = [];
      if (enrichDomainBase && enrichDomainBase.toLowerCase() !== company.toLowerCase().trim()) queries.push(enrichDomainBase);
      queries.push(company);

      for (const query of queries) {
        if (targetId) break;
        console.log(`[Enrich] Trying typeahead: ${query}`);
        try {
          const lookupRes = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(query)}&size=3`, { headers: { apikey: harmonicKey } });
          if (lookupRes.ok) {
            const lookupData = await lookupRes.json();
            const results = lookupData.results || [];
            if (results.length > 0) {
              const compLower = company.toLowerCase().trim();
              const exact = results.find(r => (r.name || '').toLowerCase().trim() === compLower);
              if (exact) {
                targetId = exact.id || (exact.entity_urn || '').split(':').pop();
                console.log(`[Enrich] Found exact match: ${exact.name} (ID: ${targetId})`);
              } else if (enrichDomainBase) {
                const domainMatch = results.find(r => (r.name || r.text || '').toLowerCase().includes(enrichDomainBase));
                if (domainMatch) {
                  targetId = domainMatch.id || (domainMatch.entity_urn || '').split(':').pop();
                  console.log(`[Enrich] Domain-name match: "${query}" → "${domainMatch.name || domainMatch.text}" (ID: ${targetId})`);
                }
              }
              if (!targetId) {
                const r0Name = (results[0].name || '').toLowerCase().trim();
                const compWords = compLower.split(/\s+/);
                const r0Words = r0Name.split(/\s+/);
                const overlap = compWords.filter(w => r0Words.some(rw => rw.includes(w) || w.includes(rw))).length;
                const similarity = overlap / Math.max(compWords.length, 1);
                if (similarity >= 0.4) {
                  const target = results[0];
                  targetId = target.id || (target.entity_urn || '').split(':').pop();
                  console.log(`[Enrich] Fuzzy match (${(similarity*100).toFixed(0)}%): "${company}" → "${target.name}" (ID: ${targetId})`);
                }
              }
            }
          }
        } catch (e) {}
      }
    }

    if (!targetId) return res.json({ error: `"${company}" not found in Harmonic` });

    // Cache the mapping for future batch-funding lookups
    try {
      const HARMONIC_CACHE_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'harmonic_id_cache.json');
      let idCache = {};
      try { if (fs.existsSync(HARMONIC_CACHE_FILE)) idCache = JSON.parse(fs.readFileSync(HARMONIC_CACHE_FILE, 'utf8')); } catch (e) {}
      // Cache with domain-aware key to prevent name collisions
      const enrichDomain = (website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
      const enrichCacheKey = enrichDomain ? `${company.toLowerCase().trim()}|${enrichDomain}` : company.toLowerCase().trim();
      idCache[enrichCacheKey] = parseInt(targetId) || targetId;
      try { fs.writeFileSync(HARMONIC_CACHE_FILE, JSON.stringify(idCache)); } catch (e) {}
      console.log(`[Enrich] Cached "${company}" → ID ${targetId} (key: ${enrichCacheKey})`);
    } catch (e) {}

    // Fetch full details
    const detailRes = await fetch(`${HARMONIC_BASE}/companies/${targetId}`, { headers: { apikey: harmonicKey } });
    if (!detailRes.ok) return res.json({ error: 'Harmonic detail fetch failed' });
    const c = await detailRes.json();

    // Build update fields — CONSERVATIVE: only write what's safe
    const updates = {};
    const f = c.funding || {};
    const fundingTotal = f.funding_total || f.fundingTotal;
    
    // ALWAYS safe: funding data (this is what enrichment is for)
    if (fundingTotal) {
      const ftNum = typeof fundingTotal === 'number' ? fundingTotal : parseFloat(fundingTotal);
      if (ftNum >= 1e9) updates['Total Funding'] = `$${(ftNum/1e9).toFixed(1)}B`;
      else if (ftNum >= 1e6) updates['Total Funding'] = `$${(ftNum/1e6).toFixed(1)}M`;
      else if (ftNum >= 1e3) updates['Total Funding'] = `$${(ftNum/1e3).toFixed(0)}K`;
      else if (ftNum > 0) updates['Total Funding'] = `$${ftNum}`;
    }
    
    // ONLY write website if Airtable has NO website
    // (never overwrite existing website — that's how bad data gets in)
    // We check this during the write phase, not here
    
    // Twitter: ONLY add if Airtable has no twitter AND we can verify via website match
    const harmonicDomain = (c.website?.domain || c.website?.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    const airtableDomain = (website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    const websiteMatch = harmonicDomain && airtableDomain && !domainsConflict(harmonicDomain, airtableDomain);
    
    if (websiteMatch && c.socials?.twitter?.url) {
      // Only set twitter if websites match (confirms right company)
      updates['_twitter_verified'] = c.socials.twitter.url;
      console.log(`[Enrich] Twitter verified via website match: ${airtableDomain} = ${harmonicDomain}`);
    }
    
    // Notes/description — always safe to add
    const desc = c.description || c.short_description || c.externalDescription || '';
    if (desc) {
      const stage = f.funding_stage || f.lastFundingType || c.stage || '';
      const loc = c.location ? [c.location.city, c.location.state, c.location.country].filter(Boolean).join(', ') : '';
      const parts = [desc.slice(0, 200)];
      if (stage) parts.push(`Stage: ${stage}`);
      if (fundingTotal) parts.push(`Raised: ${updates['Total Funding'] || fundingTotal}`);
      if (c.headcount) parts.push(`Team: ${c.headcount}`);
      if (loc) parts.push(`Location: ${loc}`);
      updates['Original Notes + Ongoing Negotiation Notes'] = parts.join(' · ');
    }

    console.log(`[Enrich] Updates for "${company}":`, Object.keys(updates).join(', '));

    // Preview mode: return proposed changes without writing
    if (preview) {
      console.log(`[Enrich] Preview for "${company}": ${Object.keys(updates).length} changes`);
      return res.json({
        success: true,
        preview: true,
        company: c.name,
        harmonic_id: targetId,
        updates,
        full_data: {
          name: c.name,
          description: (c.description || '').slice(0, 300),
          stage: f.funding_stage || f.lastFundingType || c.stage || '',
          funding_total: fundingTotal || null,
          headcount: c.headcount || null,
          location: c.location ? [c.location.city, c.location.state, c.location.country].filter(Boolean).join(', ') : '',
          website: c.website?.url || '',
          twitter: c.socials?.twitter?.url || '',
          crunchbase: c.socials?.crunchbase?.url || '',
        },
      });
    }

    // Find airtable record if no ID provided
    let recId = airtable_id;
    if (!recId) {
      const formula = encodeURIComponent(`{Company} = "${company.replace(/"/g, '\\"')}"`);
      const findRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${formula}&maxRecords=1`, { headers });
      if (findRes.ok) {
        const findData = await findRes.json();
        recId = findData.records?.[0]?.id;
      }
    }

    if (!recId) {
      console.warn(`[Enrich] No Airtable record found for "${company}"`);
      return res.json({ success: false, error: 'Company not found in Airtable', full_data: { name: c.name, description: desc.slice(0, 300), stage: f.funding_stage || c.stage, funding_total: fundingTotal, headcount: c.headcount } });
    }

    if (Object.keys(updates).length > 0) {
      // Try batch update first
      const patchRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${recId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ fields: updates }),
      });
      if (!patchRes.ok) {
        const patchErr = await patchRes.text().catch(() => '');
        console.error(`[Enrich] Batch PATCH failed: ${patchRes.status} ${patchErr.slice(0, 300)}`);
        
        // Try fields one at a time to find which one fails
        const succeeded = [];
        const failed = [];
        for (const [field, value] of Object.entries(updates)) {
          try {
            const singleRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${recId}`, {
              method: 'PATCH', headers,
              body: JSON.stringify({ fields: { [field]: value } }),
            });
            if (singleRes.ok) {
              succeeded.push(field);
              console.log(`[Enrich] ✓ Single field OK: ${field}`);
            } else {
              const singleErr = await singleRes.text().catch(() => '');
              failed.push({ field, error: singleErr.slice(0, 100) });
              console.error(`[Enrich] ✗ Single field FAILED: ${field} → ${singleRes.status} ${singleErr.slice(0, 100)}`);
            }
          } catch (e) {
            failed.push({ field, error: e.message });
          }
        }
        return res.json({ 
          success: succeeded.length > 0, 
          partial: true,
          succeeded, 
          failed: failed.map(f => `${f.field}: ${f.error}`),
          error: failed.length > 0 ? `${succeeded.length} fields written, ${failed.length} failed` : null
        });
      }
      console.log(`[Enrich] ✓ Updated "${company}" in Airtable: ${Object.keys(updates).join(', ')}`);
    } else {
      console.log(`[Enrich] No updates needed for "${company}"`);
    }

    res.json({
      success: true,
      company: c.name,
      harmonic_id: targetId,
      updates,
      full_data: {
        name: c.name,
        description: (c.description || '').slice(0, 300),
        stage: f.funding_stage || f.lastFundingType || c.stage || '',
        funding_total: fundingTotal || null,
        headcount: c.headcount || null,
        location: c.location ? [c.location.city, c.location.state, c.location.country].filter(Boolean).join(', ') : '',
        website: c.website?.url || '',
        twitter: c.socials?.twitter?.url || '',
        crunchbase: c.socials?.crunchbase?.url || '',
      },
    });
  } catch (e) {
    console.error('[Airtable] Enrich error:', e.message);
    res.json({ error: e.message });
  }
});

// Vote IN or OUT on a company
app.post('/api/airtable/vote', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!headers || !baseId) return res.json({ error: 'Airtable not configured' });

  const { voter, vote, airtable_id } = req.body;
  const company = (req.body.company || '').trim();
  if (!company || !voter || !vote) return res.status(400).json({ error: 'company, voter, and vote required' });

  try {
    let record = null;

    // PREFERRED: direct fetch by airtable_id (avoids the duplicate-record bug).
    // Frontend has airtable_id per row from /api/airtable/companies — pass it through.
    if (airtable_id) {
      const directRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${airtable_id}`, { headers });
      if (directRes.ok) record = await directRes.json();
      else console.warn(`[Airtable] Vote direct fetch ${airtable_id} failed: ${directRes.status} — falling back to name search`);
    }

    // FALLBACK: name search. If multiple records share the name (Airtable allows dupes),
    // prefer the one with the most data populated so we don't write to an empty stub.
    if (!record) {
      console.log(`[Airtable] Vote lookup: "${company}" by ${voter} (${vote}) — no airtable_id, searching by name`);
      const formula = encodeURIComponent(`{Company} = "${company.replace(/"/g, '\\"')}"`);
      const findRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${formula}&maxRecords=10`, { headers });
      if (!findRes.ok) {
        console.error(`[Airtable] Vote lookup failed: ${findRes.status}`);
        return res.json({ error: 'Airtable lookup failed' });
      }
      const findData = await findRes.json();
      const matches = findData.records || [];
      if (matches.length > 1) {
        // Prefer the record with the most populated fields (votes, harmonic_id, rating, notes)
        const score = (r) => {
          const f = r.fields || {};
          return (Array.isArray(f['IN or OUT']) ? f['IN or OUT'].length * 10 : 0)
            + (f['Harmonic ID'] ? 5 : 0)
            + (f['Initial Rating'] ? 3 : 0)
            + (f['Initial Reachout Notes'] ? 2 : 0)
            + (f['Total Funding'] ? 1 : 0);
        };
        matches.sort((a, b) => score(b) - score(a));
        console.warn(`[Airtable] DUPLICATE: ${matches.length} records for "${company}" — voting on the richest (${matches[0].id})`);
      }
      record = matches[0];
    }
    
    // Fallback: try SEARCH if exact match fails (handles special chars)
    if (!record) {
      console.log(`[Airtable] Exact match failed for "${company}", trying SEARCH...`);
      const searchFormula = encodeURIComponent(`SEARCH("${company.replace(/"/g, '\\"')}", {Company})`);
      const searchRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${searchFormula}&maxRecords=5`, { headers });
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        // Find exact match from results
        record = (searchData.records || []).find(r => (r.fields['Company'] || '').trim() === company);
        if (record) console.log(`[Airtable] SEARCH fallback found: ${record.fields['Company']}`);
      }
    }
    
    if (!record) {
      console.error(`[Airtable] Company not found: "${company}"`);
      return res.json({ error: 'Company not found in Airtable' });
    }

    // Map identity names to Airtable multi-select option names
    const voterMap = { 'Joe': 'Joe C', 'Mark': 'Mark', 'Carlo': 'Carlo', 'Jake': 'Jake', 'Liam': 'Liam' };
    const airtableVoter = voterMap[voter] || voter;

    // Get existing votes, update
    const existingVotes = record.fields['IN or OUT'] || [];
    const inKey = `${airtableVoter}: IN`;
    const outKey = `${airtableVoter}: OUT`;
    const newVotes = existingVotes.filter(v => v !== inKey && v !== outKey);
    newVotes.push(vote === 'IN' ? inKey : outKey);

    const patchRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${record.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ fields: { 'IN or OUT': newVotes } }),
    });
    if (!patchRes.ok) {
      const err = await patchRes.text().catch(() => '');
      console.error(`[Airtable] Vote PATCH failed: ${patchRes.status} ${err.slice(0, 200)}`);
      return res.json({ error: `Vote failed: ${patchRes.status}` });
    }
    console.log(`[Airtable] ${voter} voted ${vote} on "${company}"`);
    res.json({ success: true, company, voter, vote, votes: newVotes });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Direct write enrichment — takes exact fields from preview and writes them
app.post('/api/airtable/write-enrichment', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!headers || !baseId) return res.json({ error: 'Airtable not configured' });

  const { company, airtable_id, updates } = req.body;
  if (!company || !updates || Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'company and updates required' });
  }

  // Find record and get current data
  let recId = airtable_id;
  let existingFields = {};
  if (!recId) {
    const formula = encodeURIComponent(`{Company} = "${company.replace(/"/g, '\\"')}"`);
    const findRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${formula}&maxRecords=1`, { headers });
    if (findRes.ok) {
      const findData = await findRes.json();
      recId = findData.records?.[0]?.id;
      existingFields = findData.records?.[0]?.fields || {};
    }
  } else {
    // Fetch existing record to check what's already there
    const getRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${recId}`, { headers });
    if (getRes.ok) { const getData = await getRes.json(); existingFields = getData.fields || {}; }
  }
  if (!recId) return res.json({ error: 'Company not found in Airtable' });

  // Build safe writes — never overwrite existing data
  const safeUpdates = {};
  for (const [field, value] of Object.entries(updates)) {
    if (field === '_twitter_verified') {
      // Only write twitter if Airtable doesn't have one
      if (!existingFields['Twitter Link']) {
        safeUpdates['Twitter Link'] = value;
      } else {
        console.log(`[WriteEnrich] Skipping Twitter — Airtable already has: ${existingFields['Twitter Link']}`);
      }
    } else if (field === 'Company Link') {
      // NEVER overwrite website
      if (!existingFields['Company Link']) {
        safeUpdates[field] = value;
      } else {
        console.log(`[WriteEnrich] Skipping website — Airtable already has: ${existingFields['Company Link']}`);
      }
    } else {
      // Funding, Notes — always write (overwrite is fine for these)
      safeUpdates[field] = value;
    }
  }

  if (Object.keys(safeUpdates).length === 0) {
    return res.json({ success: true, fieldsWritten: [], note: 'All fields already populated' });
  }

  console.log(`[WriteEnrich] Writing ${Object.keys(safeUpdates).length} fields for "${company}": ${Object.keys(safeUpdates).join(', ')}`);
  const patchRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${recId}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ fields: safeUpdates }),
  });

  if (patchRes.ok) {
    console.log(`[WriteEnrich] ✓ All fields written for "${company}"`);
    return res.json({ success: true, fieldsWritten: Object.keys(updates) });
  }

  // Batch failed — try one by one
  const batchErr = await patchRes.text().catch(() => '');
  console.error(`[WriteEnrich] Batch failed: ${patchRes.status} ${batchErr.slice(0, 200)}`);

  const succeeded = [];
  const failed = [];
  for (const [field, value] of Object.entries(updates)) {
    try {
      const singleRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${recId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ fields: { [field]: value } }),
      });
      if (singleRes.ok) {
        succeeded.push(field);
        console.log(`[WriteEnrich] ✓ ${field}`);
      } else {
        const err = await singleRes.text().catch(() => '');
        failed.push(`${field}: ${err.slice(0, 80)}`);
        console.error(`[WriteEnrich] ✗ ${field}: ${singleRes.status}`);
      }
    } catch (e) {
      failed.push(`${field}: ${e.message}`);
    }
  }

  res.json({
    success: succeeded.length > 0,
    partial: failed.length > 0,
    succeeded,
    failed,
  });
});

// Debug: test Harmonic lookup for a single company
app.get('/api/harmonic/debug-lookup', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'No Harmonic key' });

  const name = req.query.name || '';
  const website = req.query.website || '';
  if (!name) return res.json({ error: 'name query param required' });

  const log = [];
  let harmonicId = null;
  let matchMethod = '';

  // Strategy 1: Domain
  if (website) {
    const domain = website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    log.push(`[1-domain] Trying domain: ${domain}`);
    try {
      const dr = await fetch(`${HARMONIC_BASE}/companies?website_domain=${encodeURIComponent(domain)}`, { headers: { apikey: harmonicKey } });
      const raw = dr.ok ? await dr.text() : 'not ok: ' + dr.status;
      log.push(`[1-domain] Raw response (first 500 chars): ${raw.slice(0, 500)}`);
      try {
        const dd = JSON.parse(raw);
        // Try different shapes
        const company = dd.results?.[0] || dd.companies?.[0] || dd;
        const foundId = company?.id || company?.entityId || (company?.entityUrn || '').split(':').pop() || null;
        const foundName = company?.name || company?.companyName || null;
        log.push(`[1-domain] Parsed: id=${foundId}, name=${foundName}, keys=${Object.keys(dd).join(',')}`);
        if (foundId && parseInt(foundId)) { harmonicId = parseInt(foundId); matchMethod = 'domain'; }
      } catch (e) { log.push(`[1-domain] Parse error: ${e.message}`); }
    } catch (e) { log.push(`[1-domain] Fetch error: ${e.message}`); }
  } else {
    log.push(`[1-domain] Skipped — no website`);
  }

  // Strategy 2: Typeahead
  if (!harmonicId) {
    log.push(`[2-typeahead] Trying: ${name}`);
    try {
      const tr = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(name)}&size=3`, { headers: { apikey: harmonicKey } });
      const raw = tr.ok ? await tr.text() : 'not ok: ' + tr.status;
      log.push(`[2-typeahead] Raw response (first 800 chars): ${raw.slice(0, 800)}`);
      try {
        const td = JSON.parse(raw);
        const results = td.results || td || [];
        const arr = Array.isArray(results) ? results : [];
        for (const r of arr) {
          const rid = r.id || r.entityId || (r.entity_urn || r.entityUrn || r.urn || '').split(':').pop() || null;
          const rName = r.name || r.companyName || r.title || '';
          log.push(`[2-typeahead] Result: name="${rName}", id=${rid}, keys=${Object.keys(r).join(',')}`);
          if (rid && rName.toLowerCase().trim() === name.toLowerCase().trim()) {
            harmonicId = parseInt(rid) || rid; matchMethod = 'name-exact'; break;
          }
          if (rid && (rName.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(rName.toLowerCase()))) {
            harmonicId = parseInt(rid) || rid; matchMethod = 'name-fuzzy'; break;
          }
        }
      } catch (e) { log.push(`[2-typeahead] Parse error: ${e.message}`); }
    } catch (e) { log.push(`[2-typeahead] Fetch error: ${e.message}`); }
  }

  // Strategy 3: search_agent
  if (!harmonicId) {
    log.push(`[3-search-agent] Trying: ${name}`);
    try {
      const sr = await fetch(`${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(name)}&size=3`, { headers: { apikey: harmonicKey } });
      const raw = sr.ok ? await sr.text() : 'not ok: ' + sr.status;
      log.push(`[3-search-agent] Raw response (first 800 chars): ${raw.slice(0, 800)}`);
      try {
        const sd = JSON.parse(raw);
        const results = sd.results || [];
        for (const r of results) {
          const rid = r.id || (r.urn || '').split(':').pop();
          const rName = r.name || '';
          log.push(`[3-search-agent] Result: name="${rName}", id=${rid}, urn=${r.urn}`);
        }
      } catch (e) {}
    } catch (e) { log.push(`[3-search-agent] Fetch error: ${e.message}`); }
  }

  // Strategy 4: Direct ID lookup for known ID
  if (req.query.id) {
    log.push(`[4-direct] Trying direct ID: ${req.query.id}`);
    try {
      const ir = await fetch(`${HARMONIC_BASE}/companies/${req.query.id}`, { headers: { apikey: harmonicKey } });
      const raw = ir.ok ? await ir.text() : 'not ok: ' + ir.status;
      log.push(`[4-direct] Raw response (first 500 chars): ${raw.slice(0, 500)}`);
    } catch (e) { log.push(`[4-direct] Error: ${e.message}`); }
  }

  log.push(harmonicId ? `✓ FOUND: ID ${harmonicId} via ${matchMethod}` : `✗ NOT FOUND`);
  res.json({ name, website, harmonicId, matchMethod, log });
});

// Clear Harmonic ID cache (forces re-lookup of all companies)
app.delete('/api/harmonic/cache', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const HARMONIC_CACHE_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'harmonic_id_cache.json');
  try {
    fs.writeFileSync(HARMONIC_CACHE_FILE, '{}');
    console.log('[BatchFunding] Cache cleared');
    res.json({ success: true, message: 'Harmonic ID cache cleared' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Batch funding lookup — frontend-only enrichment, no writes to Airtable
// Takes array of companies, returns Harmonic funding data matched by domain/name
app.post('/api/harmonic/batch-funding', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'Harmonic not configured', results: {} });

  const { companies } = req.body; // [{ name, website, twitter }]
  if (!companies || !Array.isArray(companies)) return res.json({ results: {} });

  const batch = companies.slice(0, 50);
  console.log(`[BatchFunding] Looking up ${batch.length} companies...`);

  // Load persistent ID cache
  const HARMONIC_CACHE_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'harmonic_id_cache.json');
  let idCache = {};
  try { if (fs.existsSync(HARMONIC_CACHE_FILE)) idCache = JSON.parse(fs.readFileSync(HARMONIC_CACHE_FILE, 'utf8')); } catch (e) {}

  function saveIdCache() {
    try { fs.writeFileSync(HARMONIC_CACHE_FILE, JSON.stringify(idCache)); } catch (e) {}
  }

  // Phase 1: Find Harmonic IDs — Airtable stored ID first, then cache, then API lookups
  const idMap = {};
  const needsLookup = [];
  const newlyMatched = []; // Track companies that need Harmonic ID saved to Airtable

  for (const co of batch) {
    const name = co.name || '';
    if (!name) continue;

    // Priority 1: Airtable-stored Harmonic ID (most reliable — manually verified)
    if (co.harmonic_id) {
      idMap[name] = { harmonicId: parseInt(co.harmonic_id), matchMethod: 'airtable' };
      console.log(`[BatchFunding] ✓ "${name}" → ID ${co.harmonic_id} (airtable)`);
      continue;
    }

    // Priority 2: Persistent cache
    const coDomain = co.website ? co.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase() : '';
    const cacheKey = coDomain ? `${name.toLowerCase().trim()}|${coDomain}` : name.toLowerCase().trim();
    const legacyCacheKey = name.toLowerCase().trim();
    if (idCache[cacheKey]) {
      idMap[name] = { harmonicId: idCache[cacheKey], matchMethod: 'cache' };
      if (co.airtable_id && !co.harmonic_id) newlyMatched.push({ airtable_id: co.airtable_id, harmonic_id: idCache[cacheKey], name });
      console.log(`[BatchFunding] ✓ "${name}" → ID ${idCache[cacheKey]} (cache, key: ${cacheKey})`);
    } else if (!coDomain && idCache[legacyCacheKey]) {
      idMap[name] = { harmonicId: idCache[legacyCacheKey], matchMethod: 'cache' };
      if (co.airtable_id && !co.harmonic_id) newlyMatched.push({ airtable_id: co.airtable_id, harmonic_id: idCache[legacyCacheKey], name });
      console.log(`[BatchFunding] ✓ "${name}" → ID ${idCache[legacyCacheKey]} (cache-legacy)`);
    } else {
      needsLookup.push(co);
    }
  }

  console.log(`[BatchFunding] ${Object.keys(idMap).length} from cache, ${needsLookup.length} need lookup`);

  // Lookup uncached companies in parallel
  const lookupPromises = needsLookup.map(async (co) => {
    const name = co.name || '';
    if (!name) return;

    try {
      let harmonicId = null;
      let matchMethod = '';

      // Typeahead — collect candidates from both name and domain base queries, pick best
      if (!harmonicId) {
        const coDomain = co.website ? co.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase() : '';
        const domainBase = coDomain ? coDomain.split('.')[0] : '';
        const coName = name.toLowerCase().trim();
        const queries = [name];
        if (domainBase && domainBase !== coName.replace(/[^a-z0-9]/g, '') && domainBase.length >= 4) queries.push(domainBase);
        if (coDomain && coDomain !== name.toLowerCase().trim() && coDomain !== domainBase) queries.push(coDomain);

        const candidates = []; // { id, method, score, closeness }
        const seenIds = new Set();
        for (const query of queries) {
          try {
            const tr = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(query)}&size=5`, { headers: { apikey: harmonicKey } });
            if (!tr.ok) continue;
            const td = await tr.json();
            const raw = (td.results || []).filter(r => r.type === 'COMPANY');

            for (const r of raw) {
              const rid = (r.entity_urn || '').split(':').pop();
              if (!rid || !parseInt(rid)) continue;
              const numId = parseInt(rid);
              if (seenIds.has(numId)) continue;
              seenIds.add(numId);
              const rText = (r.text || '').toLowerCase().trim();
              if (rText.length < 2) continue;
              const rClean = rText.replace(/[^a-z0-9]/g, '');

              let score = 0;
              let method = '';
              if (domainBase && domainBase.length >= 4 && (rClean.includes(domainBase) || domainBase.includes(rClean))) {
                score = 3; method = 'domain+typeahead';
              } else if (rText === coName) {
                score = 2; method = 'name';
              } else {
                const cleanR = rText.replace(/\.com|\.io|\.ai|\.xyz|\.co|https?:\/\//g, '').trim();
                if (cleanR.length >= 3 && (rText.includes(coName) || coName.includes(cleanR))) {
                  score = 1; method = 'name-fuzzy';
                }
              }
              if (score > 0) {
                const domainCloseness = domainBase ? (rClean === domainBase ? 1 : domainBase.includes(rClean) ? 0.8 : rClean.includes(domainBase) ? 0.7 : 0) : 0;
                const nameCloseness = rText === coName ? 1 : coName.includes(rText) ? 0.8 : rText.includes(coName) ? 0.7 : 0;
                const closeness = domainCloseness + nameCloseness;
                candidates.push({ id: numId, method, score, closeness });
              }
            }
          } catch (e) {}
        }
        if (candidates.length > 0) {
          candidates.sort((a, b) => b.score - a.score || b.closeness - a.closeness);
          const topScore = candidates[0].score;
          const tied = candidates.filter(c => c.score === topScore && c.score === 3);
          if (tied.length > 1 && coDomain) {
            try {
              const tiedGql = await gqlEnrichCompanies(tied.map(c => c.id), harmonicKey);
              // Prefer exact domain match, then non-conflicting
              for (const gc of tiedGql) {
                const gw = (gc.website?.url || gc.website?.domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
                if (gw === coDomain) { harmonicId = gc.id; matchMethod = 'domain+typeahead'; break; }
              }
              if (!harmonicId) {
                for (const gc of tiedGql) {
                  const gw = (gc.website?.url || gc.website?.domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
                  if (gw && !domainsConflict(coDomain, gw)) { harmonicId = gc.id; matchMethod = 'domain+typeahead'; break; }
                }
              }
            } catch (e) {}
          }
          if (!harmonicId) {
            harmonicId = candidates[0].id;
            matchMethod = candidates[0].method;
          }
        }
      }

      if (harmonicId) {
        idMap[name] = { harmonicId, matchMethod };
        const cacheDomain = co.website ? co.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase() : '';
        const saveCacheKey = cacheDomain ? `${name.toLowerCase().trim()}|${cacheDomain}` : name.toLowerCase().trim();
        idCache[saveCacheKey] = typeof harmonicId === 'number' ? harmonicId : parseInt(harmonicId) || harmonicId;
        if (co.airtable_id) newlyMatched.push({ airtable_id: co.airtable_id, harmonic_id: harmonicId, name });
        console.log(`[BatchFunding] ✓ "${name}" → ID ${harmonicId} (${matchMethod}, cached as: ${saveCacheKey})`);
      } else {
        console.log(`[BatchFunding] ✗ "${name}" — no match (website: ${co.website || 'none'}, twitter: ${co.twitter || 'none'})`);
      }
    } catch (e) {
      console.error(`[BatchFunding] Lookup error for "${name}":`, e.message);
    }
  });

  const CONCURRENCY = 2;
  for (let i = 0; i < lookupPromises.length; i += CONCURRENCY) {
    await Promise.all(lookupPromises.slice(i, i + CONCURRENCY));
  }

  // Save updated cache
  saveIdCache();

  console.log(`[BatchFunding] Found ${Object.keys(idMap).length}/${batch.length} Harmonic IDs`);

  // Phase 2: Batch enrich via GQL
  const results = {};
  const harmonicIds = Object.entries(idMap)
    .map(([name, { harmonicId }]) => ({ name, id: typeof harmonicId === 'number' ? harmonicId : parseInt(harmonicId) }))
    .filter(x => !isNaN(x.id));

  if (harmonicIds.length > 0) {
    try {
      const gqlCompanies = await gqlEnrichCompanies(harmonicIds.map(x => x.id), harmonicKey);
      const gqlMap = {};
      for (const gc of gqlCompanies) gqlMap[gc.id] = gc;

      for (const { name, id } of harmonicIds) {
        const gc = gqlMap[id];
        if (!gc) continue;
        const card = gqlToCard(gc);
        const { matchMethod } = idMap[name];

        // Website validation: ALWAYS check card website matches Airtable website (including cache matches)
        if (matchMethod !== 'domain') {
          const reqCo = batch.find(c => c.name === name);
          const atDomain = reqCo?.website ? reqCo.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase() : '';
          const hDomain = (card.website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
          if (atDomain && hDomain && domainsConflict(atDomain, hDomain)) {
            console.log(`[BatchFunding] REJECTED wrong company: "${name}" → "${card.name}" (${matchMethod}) — website ${atDomain} vs ${hDomain}`);
            const rejDomain = atDomain;
            if (rejDomain) delete idCache[`${name.toLowerCase().trim()}|${rejDomain}`];
            delete idCache[name.toLowerCase().trim()];
            continue;
          }
        }

        results[name] = {
          verified: true,
          matchMethod,
          confidence: matchMethod.includes('domain') ? 'high' : matchMethod === 'cache' ? 'high' : matchMethod === 'name' ? 'medium' : 'low',
          name: card.name,
          harmonicName: card.name,
          harmonic_id: id,
          funding_total: card.funding_total ? (card.funding_total >= 1e9 ? `$${(card.funding_total/1e9).toFixed(1)}B` : card.funding_total >= 1e6 ? `$${(card.funding_total/1e6).toFixed(1)}M` : card.funding_total >= 1e3 ? `$${(card.funding_total/1e3).toFixed(0)}K` : `$${card.funding_total}`) : null,
          funding_total_raw: card.funding_total,
          last_round: card.funding_stage || '',
          last_round_amount: card.last_round_amount || null,
          last_round_date: card.funding_date || '',
          stage: card.funding_stage || '',
          headcount: card.headcount || null,
          description: (card.description || '').slice(0, 200),
          website: card.website || '',
          twitter: card.socials?.twitter || '',
          logo_url: card.logo_url || '',
          location: card.location || '',
          founders: card.founders || [],
          tags: card.tags || [],
          traction: card.traction || {},
        };
      }
    } catch (e) {
      console.error('[BatchFunding] GQL enrichment error:', e.message);
      for (const { name, id } of harmonicIds) {
        results[name] = { verified: true, harmonic_id: id, matchMethod: idMap[name].matchMethod };
      }
    }
  }

  saveIdCache();
  console.log(`[BatchFunding] Enriched ${Object.keys(results).length}/${batch.length} companies`);
  res.json({ results });

  // Auto-save verified Harmonic IDs back to Airtable (fire-and-forget, after response sent)
  const toSave = newlyMatched.filter(m => results[m.name]?.verified && results[m.name]?.harmonic_id);
  if (toSave.length > 0) {
    const atKey = process.env.AIRTABLE_TOKEN;
    const atBase = process.env.AIRTABLE_BASE_ID || 'appZjMzKRqOou2OmV';
    if (atKey) {
      const records = toSave.map(m => ({ id: m.airtable_id, fields: { 'Harmonic ID': m.harmonic_id } }));
      for (let i = 0; i < records.length; i += 10) {
        const chunk = records.slice(i, i + 10);
        try {
          await fetch(`https://api.airtable.com/v0/${atBase}/ALL%20COMPANIES`, {
            method: 'PATCH', headers: { 'Authorization': `Bearer ${atKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: chunk }),
          });
          console.log(`[BatchFunding] Saved ${chunk.length} Harmonic IDs to Airtable`);
        } catch (e) { console.error('[BatchFunding] Airtable save error:', e.message); }
      }
    }
  }
});

// Manual Harmonic ID cache — seed mappings for companies that can't be auto-found
app.post('/api/harmonic/cache-id', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { name, harmonicId } = req.body;
  if (!name || !harmonicId) return res.status(400).json({ error: 'name and harmonicId required' });

  const HARMONIC_CACHE_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'harmonic_id_cache.json');
  let idCache = {};
  try { if (fs.existsSync(HARMONIC_CACHE_FILE)) idCache = JSON.parse(fs.readFileSync(HARMONIC_CACHE_FILE, 'utf8')); } catch (e) {}
  idCache[name.toLowerCase().trim()] = parseInt(harmonicId) || harmonicId;
  try { fs.writeFileSync(HARMONIC_CACHE_FILE, JSON.stringify(idCache)); } catch (e) {}

  console.log(`[HarmonicCache] Manually cached "${name}" → ID ${harmonicId}`);
  res.json({ success: true, name, harmonicId });
});

// Delete cache entry or clear all
app.delete('/api/harmonic/cache-id', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const HARMONIC_CACHE_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'harmonic_id_cache.json');
  let idCache = {};
  try { if (fs.existsSync(HARMONIC_CACHE_FILE)) idCache = JSON.parse(fs.readFileSync(HARMONIC_CACHE_FILE, 'utf8')); } catch (e) {}
  const key = req.query.key;
  if (key === 'all') {
    idCache = {};
    console.log('[HarmonicCache] Cleared all cache entries');
  } else if (key) {
    delete idCache[key];
    console.log(`[HarmonicCache] Deleted cache key: ${key}`);
  } else {
    return res.status(400).json({ error: 'key param required (or key=all to clear)' });
  }
  try { fs.writeFileSync(HARMONIC_CACHE_FILE, JSON.stringify(idCache)); } catch (e) {}
  res.json({ success: true, count: Object.keys(idCache).length });
});

// Get current cache
app.get('/api/harmonic/cache-id', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const HARMONIC_CACHE_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'harmonic_id_cache.json');
  let idCache = {};
  try { if (fs.existsSync(HARMONIC_CACHE_FILE)) idCache = JSON.parse(fs.readFileSync(HARMONIC_CACHE_FILE, 'utf8')); } catch (e) {}
  res.json({ cache: idCache, count: Object.keys(idCache).length });
});

// Save a note on a company
// POST /api/airtable/save-reachout-note — append timestamped note to Initial Reachout Notes
app.post('/api/airtable/save-reachout-note', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!headers || !baseId) return res.json({ error: 'Airtable not configured' });

  const company = (req.body.company || '').trim();
  const { author, note } = req.body;
  if (!company || !note) return res.status(400).json({ error: 'company and note required' });

  try {
    const formula = encodeURIComponent(`{Company} = "${company.replace(/"/g, '\\"')}"`);
    const findRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${formula}&maxRecords=1`, { headers });
    if (!findRes.ok) return res.json({ error: 'Airtable lookup failed' });
    const findData = await findRes.json();
    const record = findData.records?.[0];
    if (!record) return res.json({ error: 'Company not found' });

    let existing = record.fields['Initial Reachout Notes'] || '';
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) + ' EST';
    const newNote = `[${author || 'Unknown'} · ${timestamp}] ${note.trim()}`;
    // If existing notes don't have timestamps, label them as legacy
    if (existing && !existing.includes('[') && !existing.startsWith('--- Legacy')) {
      existing = `--- Legacy notes (no date) ---\n${existing}\n\n--- New notes ---`;
    }
    const updated = existing ? `${existing}\n\n${newNote}` : newNote;

    const patchRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${record.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ fields: { 'Initial Reachout Notes': updated } }),
    });
    if (!patchRes.ok) return res.json({ error: `Save failed: ${patchRes.status}` });
    console.log(`[Airtable] Reachout note saved on "${company}" by ${author}`);
    res.json({ success: true, notes: updated });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/airtable/save-note', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!headers || !baseId) return res.json({ error: 'Airtable not configured' });

  const company = (req.body.company || '').trim();
  const { author, note } = req.body;
  if (!company || !note) return res.status(400).json({ error: 'company and note required' });

  try {
    const formula = encodeURIComponent(`{Company} = "${company.replace(/"/g, '\\"')}"`);
    const findRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${formula}&maxRecords=1`, { headers });
    if (!findRes.ok) return res.json({ error: 'Airtable lookup failed' });
    const findData = await findRes.json();
    const record = findData.records?.[0];
    if (!record) return res.json({ error: 'Company not found' });

    const existing = record.fields['Original Notes + Ongoing Negotiation Notes'] || '';
    const timestamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const newNote = `[${author || 'Unknown'} · ${timestamp}] ${note.trim()}`;
    const updated = existing ? `${existing}\n\n${newNote}` : newNote;

    const patchRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}/${record.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ fields: { 'Original Notes + Ongoing Negotiation Notes': updated } }),
    });
    if (!patchRes.ok) return res.json({ error: `Save failed: ${patchRes.status}` });
    console.log(`[Airtable] Note saved on "${company}" by ${author}`);
    res.json({ success: true, notes: updated });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Full company detail by Harmonic ID — returns everything including people/founders
app.get('/api/harmonic/company/:id/full', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'Harmonic not configured' });

  const companyId = req.params.id;
  try {
    const cr = await fetch(`${HARMONIC_BASE}/companies/${companyId}`, { headers: { apikey: harmonicKey } });
    if (!cr.ok) return res.json({ error: `Harmonic error: ${cr.status}` });
    const c = await cr.json();

    // Also fetch people/founders
    let people = [];
    try {
      // Try /companies/:id/people endpoint
      const pr = await fetch(`${HARMONIC_BASE}/companies/${companyId}/people?size=30`, { headers: { apikey: harmonicKey } });
      if (pr.ok) {
        const pd = await pr.json();
        console.log(`[CompanyFull] People endpoint keys: ${Object.keys(pd).join(', ')}`);
        people = pd.results || pd.people || pd.data || [];
        if (people.length === 0 && Array.isArray(pd)) people = pd;
      } else {
        console.log(`[CompanyFull] People endpoint failed: ${pr.status}`);
      }
    } catch (e) { console.log(`[CompanyFull] People endpoint error: ${e.message}`); }

    // If no people from /people endpoint, try the company object itself
    if (people.length === 0 && c.people) people = c.people;
    if (people.length === 0 && c.founders) people = c.founders;
    if (people.length === 0 && c.team_members) people = c.team_members;

    // Also check for people in highlighted_team_members or key_people
    if (people.length === 0 && c.highlighted_team_members) people = c.highlighted_team_members;
    if (people.length === 0 && c.key_people) people = c.key_people;

    console.log(`[CompanyFull] Found ${people.length} people. First person keys: ${people.length > 0 ? Object.keys(people[0]).join(', ') : 'none'}`);
    if (people.length > 0 && people[0].person) {
      console.log(`[CompanyFull] person field type: ${typeof people[0].person}, keys: ${typeof people[0].person === 'object' ? Object.keys(people[0].person).join(', ') : 'N/A'}`);
    }

    // Step 1: Extract person IDs
    if (people.length > 0) {
      console.log(`[CompanyFull] First person raw: ${JSON.stringify(people[0]).slice(0, 300)}`);
    }
    const flatPeople = people.map(p => {
      // person field could be: string URN, number ID, or object
      let personId = null;
      if (typeof p.person === 'string') {
        // Could be URN like "urn:harmonic:person:12345" or plain ID
        personId = p.person.includes(':') ? p.person.split(':').pop() : p.person;
      } else if (typeof p.person === 'number') {
        personId = String(p.person);
      } else if (p.person?.id) {
        personId = String(p.person.id);
      }
      return { ...p, _personId: personId || p.id || null };
    });

    // Step 2: Only enrich founders (people with founder/CEO titles) — max 8 individual fetches
    const enrichedPeople = [];
    for (const p of flatPeople.slice(0, 30)) {
      const pid = p._personId;
      const hasName = p.full_name || p.name || p.first_name;
      const isFounderTitle = (p.title || '').toLowerCase().match(/founder|ceo|co-founder|cofounder|chief executive/);
      
      if (pid && !hasName && (isFounderTitle || enrichedPeople.length < 8)) {
        try {
          // Try multiple endpoint formats
          let pd = null;
          // Try 1: /people/{id}
          let pr = await fetch(`${HARMONIC_BASE}/people/${pid}`, { headers: { apikey: harmonicKey } });
          if (pr.ok) { pd = await pr.json(); }
          // Try 2: /persons/{urn} with full URN
          if (!pd) {
            const urn = p.person || `urn:harmonic:person:${pid}`;
            pr = await fetch(`${HARMONIC_BASE}/persons/${encodeURIComponent(urn)}`, { headers: { apikey: harmonicKey } });
            if (pr.ok) pd = await pr.json();
          }
          // Try 3: /people with URN as query
          if (!pd) {
            pr = await fetch(`${HARMONIC_BASE}/people?person_urn=urn:harmonic:person:${pid}`, { headers: { apikey: harmonicKey } });
            if (pr.ok) pd = await pr.json();
          }
          if (pd && (pd.full_name || pd.name || pd.first_name)) {
            pd.title = pd.title || p.title;
            pd.department = pd.department || p.department;
            enrichedPeople.push(pd);
            console.log(`[CompanyFull] ✓ ${pd.full_name || pd.name || '?'} (${pd.title || ''})`);
            continue;
          } else {
            console.log(`[CompanyFull] ✗ Person ${pid}: all endpoints failed`);
          }
        } catch (e) {
          console.log(`[CompanyFull] ✗ Person ${pid} error: ${e.message}`);
        }
      }
      enrichedPeople.push(p);
    }

    people = enrichedPeople;
    console.log(`[CompanyFull] ${c.name}: ${people.length} people, names: ${people.slice(0, 5).map(p => p.full_name || p.name || p.first_name || '?').join(', ')}`);

    const f = c.funding || {};
    const ft = f.funding_total || f.fundingTotal || null;

    // Extract traction/web traffic data
    const traction = c.traction_metrics || {};
    const rawWebTrafficSimple = c.web_traffic; // plain number
    const rawWebTrafficDetailed = traction.web_traffic; // object with metrics
    console.log(`[CompanyFull] Web traffic simple: ${rawWebTrafficSimple}, detailed type: ${typeof rawWebTrafficDetailed}, detailed: ${JSON.stringify(rawWebTrafficDetailed).slice(0, 200)}`);
    
    let webTrafficValue = null;
    let webTrafficChange30d = null;
    let webTrafficChange365d = null;
    let webTrafficMetrics = [];
    
    if (rawWebTrafficDetailed && typeof rawWebTrafficDetailed === 'object') {
      webTrafficValue = rawWebTrafficDetailed.latest_metric_value || rawWebTrafficDetailed['14d_ago']?.value || rawWebTrafficSimple || null;
      webTrafficChange30d = rawWebTrafficDetailed['30d_ago']?.percent_change || null;
      webTrafficChange365d = rawWebTrafficDetailed['365d_ago']?.percent_change || null;
      webTrafficMetrics = rawWebTrafficDetailed.metrics || [];
    } else {
      webTrafficValue = rawWebTrafficSimple || null;
    }
    
    // Extract contact info
    const contact = c.contact || {};
    console.log(`[CompanyFull] Contact raw: ${JSON.stringify(contact).slice(0, 300)}`);
    const execEmails = contact.exec_emails || contact.executive_emails || [];
    const companyEmails = contact.emails || [];
    const phone = contact.phone_numbers || contact.phones || [];
    const primaryEmail = contact.primary_email || '';

    console.log(`[CompanyFull] Raw company keys: ${Object.keys(c).join(', ')}`);
    if (c.traction_metrics) console.log(`[CompanyFull] Traction keys: ${Object.keys(c.traction_metrics).join(', ')}`);
    if (c.contact) console.log(`[CompanyFull] Contact keys: ${Object.keys(c.contact).join(', ')}`);
    if (c.socials) console.log(`[CompanyFull] Socials: ${JSON.stringify(c.socials).slice(0, 400)}`);

    res.json({
      id: c.id,
      name: c.name,
      description: c.description || c.short_description || '',
      website: c.website?.url || '',
      domain: c.website?.domain || '',
      logo_url: c.logo_url || c.logoUrl || '',
      stage: f.funding_stage || f.lastFundingType || c.stage || '',
      headcount: c.headcount || c.employee_count || null,
      founded_year: c.founded_date ? new Date(c.founded_date).getFullYear() : (c.founded_year || null),
      location: c.location ? [c.location.city, c.location.state, c.location.country].filter(Boolean).join(', ') : '',
      funding_total: ft,
      funding_rounds: f.funding_rounds || f.fundingRounds || [],
      last_funding_type: f.lastFundingType || f.last_funding_type || '',
      last_funding_total: f.lastFundingTotal || f.last_funding_total || null,
      last_funding_date: f.lastFundingAt || f.last_funding_at || '',
      num_funding_rounds: f.numFundingRounds || f.num_funding_rounds || null,
      investors: f.investors || [],
      tags: c.tags || c.industries || [],
      // Traction / web traffic
      web_traffic: webTrafficValue,
      web_traffic_change_30d: webTrafficChange30d,
      web_traffic_change_365d: webTrafficChange365d,
      web_traffic_history: webTrafficMetrics.slice(-12),
      traction: {
        webTraffic: webTrafficValue,
        webGrowth30d: webTrafficChange30d || (traction.web_traffic?.ago30d?.percentChange ?? null),
        webGrowth90d: traction.web_traffic?.['90d_ago']?.percent_change ?? traction.web_traffic?.ago90d?.percentChange ?? null,
        hcGrowth30d: traction.headcount?.['30d_ago']?.percent_change ?? traction.headcount?.ago30d?.percentChange ?? null,
        hcGrowth90d: traction.headcount?.['90d_ago']?.percent_change ?? traction.headcount?.ago90d?.percentChange ?? null,
      }, // last 12 months
      twitter_followers: traction.twitter_follower_count || null,
      // Headcount & engineering growth
      headcount_growth_90d: traction.headcount?.['90d_ago']?.percent_change ?? traction.headcount?.ago90d?.percentChange ?? null,
      headcount_growth_180d: traction.headcount?.['180d_ago']?.percent_change ?? traction.headcount?.ago180d?.percentChange ?? null,
      eng_headcount_growth_90d: traction.headcount_engineering?.['90d_ago']?.percent_change ?? traction.headcountEngineering?.ago90d?.percentChange ?? null,
      eng_headcount_growth_180d: traction.headcount_engineering?.['180d_ago']?.percent_change ?? traction.headcountEngineering?.ago180d?.percentChange ?? null,
      // Contact info
      contact: {
        executive_emails: execEmails,
        company_emails: companyEmails,
        phone: phone,
        primary_email: primaryEmail,
      },
      people: enrichedPeople.map(p => ({
        id: p.id,
        name: p.full_name || p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') || '',
        title: p.title || p.role || p.position || p.headline || '',
        linkedin: p.socials?.linkedin?.url || p.linkedin_url || p.linkedin || '',
        twitter: p.socials?.twitter?.url || p.twitter_url || '',
        photo: p.photo_url || p.profile_picture_url || p.avatar_url || p.image_url || '',
        experience: p.experience || p.work_experience || p.employment_history || p.positions || [],
        education: p.education || p.educations || [],
        is_founder: p.is_founder || p.founder || (p.title || '').toLowerCase().includes('founder') || (p.title || '').toLowerCase().includes('ceo') || (p.role || '').toLowerCase().includes('founder'),
        bio: p.bio || p.summary || p.about || '',
      })),
      socials: (() => {
        const s = c.socials || {};
        const get = (key) => s[key]?.url || s[key.toUpperCase()]?.url || (typeof s[key] === 'string' ? s[key] : '') || (typeof s[key.toUpperCase()] === 'string' ? s[key.toUpperCase()] : '');
        return { twitter: get('twitter'), linkedin: get('linkedin'), crunchbase: get('crunchbase'), github: get('github'), facebook: get('facebook'), pitchbook: get('pitchbook'), angellist: get('angellist'), instagram: get('instagram') };
      })(),
      raw_funding: f,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Lookup company by domain — exact match
app.get('/api/harmonic/company-by-domain', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json({ error: 'Harmonic not configured' });
  const domain = (req.query.domain || '').trim();
  const name = (req.query.name || '').trim();
  if (!domain) return res.status(400).json({ error: 'domain required' });

  try {
    let full = null;

    // Strategy 1: Direct domain lookup
    console.log(`[PortcoLookup] Trying domain: ${domain} (name: ${name})`);
    const r = await fetch(`${HARMONIC_BASE}/companies?website_domain=${encodeURIComponent(domain)}`, { headers: { apikey: harmonicKey } });
    if (r.ok) {
      const c = await r.json();
      if (c.id) {
        const dr = await fetch(`${HARMONIC_BASE}/companies/${c.id}`, { headers: { apikey: harmonicKey } });
        full = dr.ok ? await dr.json() : c;
        console.log(`[PortcoLookup] ✓ Domain match: ${full.name} (${domain})`);
      }
    }

    // Strategy 2: Try with www. prefix
    if (!full) {
      const r2 = await fetch(`${HARMONIC_BASE}/companies?website_domain=${encodeURIComponent('www.' + domain)}`, { headers: { apikey: harmonicKey } });
      if (r2.ok) {
        const c2 = await r2.json();
        if (c2.id) {
          const dr2 = await fetch(`${HARMONIC_BASE}/companies/${c2.id}`, { headers: { apikey: harmonicKey } });
          full = dr2.ok ? await dr2.json() : c2;
          console.log(`[PortcoLookup] ✓ www match: ${full.name}`);
        }
      }
    }

    // Strategy 3: Typeahead by company name, verify by domain
    if (!full && name) {
      console.log(`[PortcoLookup] Trying typeahead by name: "${name}"`);
      const tr = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(name)}&size=5`, { headers: { apikey: harmonicKey } });
      if (tr.ok) {
        const td = await tr.json();
        const results = td.results || [];
        for (const item of results) {
          const rid = item.id || (item.entity_urn || '').split(':').pop();
          if (!rid) continue;
          const cr = await fetch(`${HARMONIC_BASE}/companies/${rid}`, { headers: { apikey: harmonicKey } });
          if (!cr.ok) continue;
          const cd = await cr.json();
          const hDomain = (cd.website?.domain || cd.website?.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
          const targetDomain = domain.toLowerCase();
          const hBase = hDomain.split('.')[0];
          const tBase = targetDomain.split('.')[0];
          // Require exact domain match or same base name with different TLD
          if (hDomain === targetDomain || hDomain === 'www.' + targetDomain || (hBase === tBase && hBase.length >= 4)) {
            full = cd;
            console.log(`[PortcoLookup] ✓ Name typeahead+domain verify: ${full.name} (${hDomain})`);
            break;
          }
        }
      }
    }

    // Strategy 4: Typeahead by domain prefix
    if (!full) {
      const searchTerm = domain.split('.')[0];
      if (searchTerm.length >= 3) {
        console.log(`[PortcoLookup] Trying typeahead by domain prefix: "${searchTerm}"`);
        const tr = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(searchTerm)}&size=5`, { headers: { apikey: harmonicKey } });
        if (tr.ok) {
          const td = await tr.json();
          const results = td.results || [];
          for (const item of results) {
            const rid = item.id || (item.entity_urn || '').split(':').pop();
            if (!rid) continue;
            const cr = await fetch(`${HARMONIC_BASE}/companies/${rid}`, { headers: { apikey: harmonicKey } });
            if (!cr.ok) continue;
            const cd = await cr.json();
            const hDomain = (cd.website?.domain || cd.website?.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
            const targetDomain = domain.toLowerCase();
            const hBase = hDomain.split('.')[0];
            const tBase = targetDomain.split('.')[0];
            if (hDomain === targetDomain || hDomain === 'www.' + targetDomain || (hBase === tBase && hBase.length >= 4)) {
              full = cd;
              console.log(`[PortcoLookup] ✓ Domain prefix typeahead: ${full.name} (${hDomain})`);
              break;
            }
          }
        }
      }
    }

    // Strategy 5: Name typeahead — only accept if domain matches OR names are nearly identical
    if (!full && name) {
      console.log(`[PortcoLookup] Trying strict name match: "${name}"`);
      const tr = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(name)}&size=5`, { headers: { apikey: harmonicKey } });
      if (tr.ok) {
        const td = await tr.json();
        const results = td.results || [];
        for (const item of results) {
          const rid = item.id || (item.entity_urn || '').split(':').pop();
          if (!rid) continue;
          const cr = await fetch(`${HARMONIC_BASE}/companies/${rid}`, { headers: { apikey: harmonicKey } });
          if (!cr.ok) continue;
          const cd = await cr.json();
          const hName = (cd.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const searchName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
          // Require names to be nearly identical length (within 30%)
          const lenRatio = Math.min(hName.length, searchName.length) / Math.max(hName.length, searchName.length);
          const hDomain = (cd.website?.domain || cd.website?.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
          const targetDomain = domain.toLowerCase();
          const hBase = hDomain.split('.')[0];
          const tBase = targetDomain.split('.')[0];
          const domainMatch = hDomain === targetDomain || (hBase === tBase && hBase.length >= 4);
          if (domainMatch || (lenRatio > 0.7 && (hName === searchName || hName.startsWith(searchName) || searchName.startsWith(hName)))) {
            full = cd;
            console.log(`[PortcoLookup] ✓ Strict name match: ${full.name} (domain: ${hDomain}, lenRatio: ${lenRatio.toFixed(2)})`);
            break;
          }
        }
      }
    }

    if (!full) {
      console.log(`[PortcoLookup] ✗ Not found: ${domain}`);
      return res.json({ error: 'Not found' });
    }

    const f = full.funding || {};
    const ft = f.funding_total || f.fundingTotal || null;
    const funding = ft ? (typeof ft === 'number' ? (ft >= 1e9 ? `$${(ft/1e9).toFixed(1)}B` : ft >= 1e6 ? `$${(ft/1e6).toFixed(1)}M` : ft >= 1e3 ? `$${(ft/1e3).toFixed(0)}K` : `$${ft}`) : ft) : null;

    // Extract traction metrics
    const tm = full.tractionMetrics || {};
    const traction = {
      webTraffic: full.webTraffic || full.web_traffic || null,
      webGrowth30d: tm.webTraffic?.ago30d?.percentChange || null,
      webGrowth90d: tm.webTraffic?.ago90d?.percentChange || null,
      hcGrowth30d: tm.headcount?.ago30d?.percentChange || null,
      hcGrowth90d: tm.headcount?.ago90d?.percentChange || null,
    };

    res.json({
      id: full.id,
      name: full.name || domain,
      domain: full.website?.domain || domain,
      logo_url: full.logo_url || full.logoUrl || '',
      description: (full.description || full.short_description || '').slice(0, 150),
      stage: f.funding_stage || f.lastFundingType || full.stage || '',
      headcount: full.headcount || null,
      website: full.website?.url || `https://${domain}`,
      funding_total: ft,
      funding_display: funding,
      location: full.location ? [full.location.city, full.location.state, full.location.country].filter(Boolean).join(', ') : '',
      twitter: full.socials?.twitter?.url || '',
      entity_urn: full.entity_urn || '',
      traction,
    });
  } catch (e) {
    console.error(`[PortcoLookup] Error for ${domain}:`, e.message);
    res.json({ error: e.message });
  }
});

// Check Twitter activity — get last tweet date for a list of handles
app.post('/api/twitter/check-activity', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  if (!rapidApiKey) return res.json({ error: 'RAPIDAPI_KEY not configured', results: {} });

  const { accounts } = req.body;
  if (!accounts || !Array.isArray(accounts)) return res.json({ results: {} });

  const results = {};
  const batch = accounts.filter(a => a.twitter_url).slice(0, 20);
  const rapidHeaders = { 'x-rapidapi-host': 'twitter-v24.p.rapidapi.com', 'x-rapidapi-key': rapidApiKey };
  console.log(`[TwitterActivity] Checking ${batch.length} accounts...`);

  for (const acct of batch) {
    const handle = acct.twitter_url
      .replace(/^https?:\/\/(x|twitter)\.com\//, '')
      .replace(/\/$/, '')
      .split('?')[0];
    if (!handle || handle.includes('/')) continue;

    try {
      // Use the same search endpoint that works in the Twitter scanner
      const url = `https://twitter-v24.p.rapidapi.com/search/?query=${encodeURIComponent(`from:${handle}`)}&section=latest&limit=5`;
      const r = await fetch(url, { headers: rapidHeaders });

      if (!r.ok) {
        console.warn(`[TwitterActivity] Search failed for @${handle}: ${r.status}`);
        results[acct.name] = { handle, status: 'error', days_since: null };
        continue;
      }

      const data = await r.json();

      // Parse using the same nested format as the working Twitter scanner
      let instructions = data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
      if (instructions.length === 0) instructions = data?.data?.search?.timeline_response?.timeline?.instructions || [];
      if (instructions.length === 0 && data?.timeline) instructions = data.timeline?.instructions || [];

      let latestDate = null;
      let latestText = '';

      for (const instr of instructions) {
        const entries = instr.entries || [];
        for (const entry of entries) {
          try {
            const result = entry?.content?.itemContent?.tweet_results?.result;
            if (!result?.legacy) continue;
            const tweet = result.legacy;
            const tweetDate = tweet.created_at ? new Date(tweet.created_at) : null;
            if (tweetDate && !isNaN(tweetDate) && (!latestDate || tweetDate > latestDate)) {
              latestDate = tweetDate;
              latestText = (tweet.full_text || tweet.text || '').slice(0, 100);
            }
          } catch (e) {}
        }
      }

      if (latestDate) {
        const daysSince = Math.floor((Date.now() - latestDate.getTime()) / 86400000);
        let status = 'active';
        if (daysSince > 30) status = 'inactive';
        else if (daysSince > 10) status = 'quiet';

        results[acct.name] = {
          handle,
          status,
          last_tweet_date: latestDate.toISOString().split('T')[0],
          days_since: daysSince,
          last_tweet_text: latestText,
        };
        console.log(`[TwitterActivity] @${handle}: ${status} (${daysSince}d ago) — "${latestText.slice(0, 40)}"`);
      } else {
        console.log(`[TwitterActivity] @${handle}: no tweets parsed from response`);
        results[acct.name] = { handle, status: 'no_tweets', days_since: null };
      }
    } catch (e) {
      console.error(`[TwitterActivity] Error for @${handle}:`, e.message);
      results[acct.name] = { handle, status: 'error', error: e.message };
    }

    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`[TwitterActivity] Done: ${Object.keys(results).length} checked`);
  res.json({ results });
});

// ==========================================
// DEEP SCAN AGENT — Concurrent deep scans
// ==========================================

const SCAN_VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp';
const SCANS_STATE_FILE = path.join(SCAN_VOLUME, 'deep_scans_state.json');

function loadScansState() {
  try {
    const data = JSON.parse(fs.readFileSync(SCANS_STATE_FILE, 'utf8'));
    const bootTime = Date.now();
    for (const id of Object.keys(data)) {
      if (data[id].status === 'scanning') {
        data[id].status = 'interrupted';
        data[id].progress = `Interrupted (server restarted) — was at: ${data[id].progress || 'unknown phase'}`;
        // Effective death time = boot time (the actual kill happened seconds before)
        if (!data[id].interruptedAt) data[id].interruptedAt = bootTime;
      }
    }
    return data;
  } catch {
    // Migrate from old single-scan format
    try {
      const old = JSON.parse(fs.readFileSync(path.join(SCAN_VOLUME, 'recurring_scan_state.json'), 'utf8'));
      if (old && old.status && old.status !== 'idle') {
        const id = (old.startedAt || Date.now()).toString(36);
        if (old.status === 'scanning') { old.status = 'interrupted'; old.progress = `Interrupted — was at: ${old.progress || 'unknown'}`; old.interruptedAt = Date.now(); }
        old.id = id; old.user = old.user || 'Mark';
        return { [id]: old };
      }
    } catch {}
    return {};
  }
}

function saveScansState() {
  try {
    const toSave = {};
    for (const [id, s] of Object.entries(global._deepScans || {})) {
      toSave[id] = {
        id: s.id, status: s.status, progress: s.progress, stats: { ...(s.stats || {}) },
        startedAt: s.startedAt, tier: s.tier, user: s.user || 'Mark', options: s.options,
        lastUpdatedAt: s.lastUpdatedAt || s.startedAt,
        interruptedAt: s.interruptedAt || null,
        finishedAt: s.finishedAt || null,
      };
    }
    fs.writeFileSync(SCANS_STATE_FILE, JSON.stringify(toSave));
  } catch (e) {}
}

// Graceful shutdown: mark any running scans as interrupted with the exact moment
// of shutdown, so the next boot doesn't have to guess (and the UI shows accurate
// "ran for X" math instead of using boot time).
function markRunningScansInterruptedOnShutdown(signal) {
  try {
    const now = Date.now();
    let n = 0;
    for (const s of Object.values(global._deepScans || {})) {
      if (s.status === 'scanning') {
        s.status = 'interrupted';
        s.progress = `Interrupted (server ${signal}) — was at: ${s.progress || 'unknown phase'}`;
        s.interruptedAt = now;
        n++;
      }
    }
    if (n > 0) saveScansState();
    console.log(`[Scans] Graceful ${signal}: marked ${n} scanning → interrupted`);
  } catch (e) { console.error('[Scans] shutdown handler error:', e.message); }
}
process.on('SIGTERM', () => { markRunningScansInterruptedOnShutdown('SIGTERM'); });
process.on('SIGINT', () => { markRunningScansInterruptedOnShutdown('SIGINT'); process.exit(0); });

if (!global._deepScans) {
  global._deepScans = loadScansState();
  if (Object.keys(global._deepScans).length > 0) saveScansState();
}

function cleanupOldScans() {
  const completed = Object.values(global._deepScans).filter(s => s.status !== 'scanning').sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  for (const s of completed.slice(8)) delete global._deepScans[s.id];
  saveScansState();
}

const SCAN_TIERS = {
  scout:    { name: 'Quick Scout',    cost: '$5',  budget: 5,   ddPush: 3,  etaMin: 3,  etaMax: 6,  preModel: 'claude-haiku-4-5-20251001', preMax: 1500, screenModel: 'claude-sonnet-4-20250514', screenMax: 200, deepModel: 'claude-sonnet-4-20250514', deepMax: 25,  preBatch: 200, screenBatch: 80, deepBatch: 10, desc: 'Haiku pre-screen → Sonnet scoring → Sonnet deep (budget-capped) → top to DD' },
  standard: { name: 'Standard',      cost: '$12', budget: 12,  ddPush: 8,  etaMin: 8,  etaMax: 15, preModel: 'claude-sonnet-4-20250514',  preMax: 1500, screenModel: 'claude-sonnet-4-20250514', screenMax: 200, deepModel: 'claude-opus-4-6',          deepMax: 80,  preBatch: 120, screenBatch: 50, deepBatch: 15, desc: 'Sonnet pre-screen → Sonnet scoring → Opus deep (budget-capped) → top to DD' },
  deep:     { name: 'Deep Dive',     cost: '$25', budget: 25,  ddPush: 15, etaMin: 18, etaMax: 32, preModel: 'claude-sonnet-4-20250514',  preMax: 5000, screenModel: 'claude-sonnet-4-20250514', screenMax: 500, deepModel: 'claude-opus-4-6',          deepMax: 150, preBatch: 120, screenBatch: 50, deepBatch: 15, desc: 'Sonnet all → Sonnet scoring → Opus deep (budget-capped) → top to DD' },
  sweep:    { name: 'Full Sweep',    cost: '$35', budget: 35,  ddPush: 25, etaMin: 30, etaMax: 50, preModel: 'claude-sonnet-4-20250514',  preMax: 9999, screenModel: 'claude-sonnet-4-20250514', screenMax: 999, deepModel: 'claude-opus-4-6',          deepMax: 300, preBatch: 120, screenBatch: 50, deepBatch: 15, desc: 'Sonnet full → Sonnet scoring → Opus deep (budget-capped) → top to DD' },
  maximum:  { name: 'Maximum',       cost: '$50', budget: 50,  ddPush: 40, etaMin: 45, etaMax: 75, preModel: 'claude-sonnet-4-20250514',  preMax: 9999, screenModel: 'claude-sonnet-4-20250514', screenMax: 999, deepModel: 'claude-opus-4-6',          deepMax: 500, preBatch: 120, screenBatch: 50, deepBatch: 15, desc: 'Full pipeline → Opus deep (budget-capped) → top to DD' },
};

const RECURRING_HISTORY_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'recurring_scan_history.json');
function loadRecurringScanHistory() { try { return JSON.parse(fs.readFileSync(RECURRING_HISTORY_FILE, 'utf8')); } catch { return []; } }
function saveRecurringScanHistory(history) { try { fs.writeFileSync(RECURRING_HISTORY_FILE, JSON.stringify(history.slice(0, 20), null, 2)); } catch (e) {} }

app.get('/api/recurring-scan/tiers', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(SCAN_TIERS);
});

app.get('/api/recurring-scan/status', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const scans = Object.values(global._deepScans).map(s => ({
    id: s.id, status: s.status, progress: s.progress, stats: s.stats || {},
    startedAt: s.startedAt, tier: s.tier, user: s.user || 'Mark',
    lastUpdatedAt: s.lastUpdatedAt || s.startedAt || null,
    interruptedAt: s.interruptedAt || null,
    finishedAt: s.finishedAt || null,
  }));
  res.json({ scans });
});

const PORTCO_LIST = ['steel.dev','bubblemaps.io','pump.fun','xverse.app','trendex.vip','haloo.ai','hirechain.io','botanixlabs.xyz','pear.garden','lagoon.finance','aura.fun','ord.io','kinddesigns.com','raze.finance','bound.money','worm.wtf','vest.markets'];

app.get('/api/recurring-scan/portcos', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(PORTCO_LIST);
});

// Search counts cached monthly to disk for cost estimation
const SEARCH_COUNTS_FILE = path.join(SCAN_VOLUME, 'search_counts.json');
const COUNTS_CACHE_DAYS = 30;
function loadSearchCounts() { try { return JSON.parse(fs.readFileSync(SEARCH_COUNTS_FILE, 'utf8')); } catch { return { counts: {}, updatedAt: 0 }; } }
function saveSearchCounts(data) { try { fs.writeFileSync(SEARCH_COUNTS_FILE, JSON.stringify(data)); } catch {} }

async function refreshSearchCounts(searches, harmonicKey) {
  const counts = {};
  const authH = { apikey: harmonicKey, Accept: 'application/json' };
  for (const s of searches) {
    try {
      const r = await fetch(`${HARMONIC_BASE}/savedSearches:results/${s.id}?size=1`, { headers: authH });
      if (r.ok) {
        const data = await r.json();
        const pi = data.page_info || data.pageInfo || {};
        counts[s.id] = pi.total_count || pi.total || pi.count || pi.totalCount || (pi.has_next ? '500+' : (data.results || data.data || []).length);
      }
    } catch {}
    await sleep(200);
  }
  const result = { counts, updatedAt: Date.now() };
  saveSearchCounts(result);
  return result;
}

let _cachedSearches = null;
let _cachedSearchesAt = 0;
app.get('/api/recurring-scan/searches', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const harmonicKey = process.env.HARMONIC_API_KEY;
  if (!harmonicKey) return res.json([]);
  if (_cachedSearches && Date.now() - _cachedSearchesAt < 300000) return res.json(_cachedSearches);
  try {
    const authH = { apikey: harmonicKey, Accept: 'application/json' };
    const r = await fetch(`${HARMONIC_BASE}/savedSearches`, { headers: authH });
    if (!r.ok) return res.json([]);
    const data = await r.json();
    const searches = (Array.isArray(data) ? data : (data.results || [])).filter(s => {
      const type = (s.type || '').toUpperCase();
      return type !== 'PERSONS_LIST' && type !== 'PERSONS' && type !== 'PERSON' && type !== 'PEOPLE';
    }).map(s => ({ id: String(s.id), name: s.name || s.title || `Search ${s.id}`, type: s.type }));

    // Attach cached counts (refresh in background if stale)
    const countData = loadSearchCounts();
    const isStale = !countData.updatedAt || (Date.now() - countData.updatedAt > COUNTS_CACHE_DAYS * 24 * 60 * 60 * 1000);
    const countsMap = countData.counts || {};

    const result = searches.map(s => ({ ...s, resultCount: countsMap[s.id] || null }));
    _cachedSearches = result;
    _cachedSearchesAt = Date.now();

    if (isStale) {
      // Refresh counts in background (don't block response)
      refreshSearchCounts(searches, harmonicKey).then(newCounts => {
        _cachedSearches = searches.map(s => ({ ...s, resultCount: newCounts.counts[s.id] || null }));
        console.log('[DeepScan] Search counts refreshed:', newCounts.counts);
      }).catch(e => console.error('[DeepScan] Count refresh error:', e.message));
    }

    res.json(result);
  } catch (e) { res.json([]); }
});

// Batch inspection endpoint — returns batch-level data for a running/completed scan
app.get('/api/recurring-scan/batches/:scanId', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const scan = global._deepScans[req.params.scanId];
  if (!scan) return res.json({ batches: [] });
  res.json({ batches: scan._batches || [] });
});

app.get('/api/recurring-scan/results', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const RESULTS_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'recurring_scan_results.json');
  try {
    const data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    res.json(data);
  } catch (e) {
    res.json({ results: [], timestamp: null });
  }
});

app.get('/api/recurring-scan/history', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(loadRecurringScanHistory());
});

app.post('/api/recurring-scan/cancel', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { id } = req.body || {};
  if (id && global._deepScans[id]) {
    const s = global._deepScans[id];
    if (s.status === 'scanning') {
      s._cancelled = true; s.status = 'cancelled'; s.progress = 'Cancelled by user';
    } else if (s.status === 'interrupted') {
      delete global._deepScans[id];
    }
  } else if (!id) {
    for (const [sid, s] of Object.entries(global._deepScans)) {
      if (s.status === 'scanning') { s._cancelled = true; s.status = 'cancelled'; s.progress = 'Cancelled by user'; }
      if (s.status === 'interrupted') { delete global._deepScans[sid]; }
    }
  }
  saveScansState();
  res.json({ ok: true });
});

app.post('/api/recurring-scan', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // CRITICAL — without this, Railway's proxy buffers the SSE stream

  let clientConnected = true;
  req.on('close', () => { clientConnected = false; });

  const safeWrite = (msg) => { try { if (clientConnected) res.write(msg); } catch (e) {} };

  const anthropicKey = req.headers['x-anthropic-key'] || req.body?.anthropicKey;
  const harmonicKey = process.env.HARMONIC_API_KEY;
  const tierKey = req.headers['x-scan-tier'] || req.body?.tier || 'standard';

  let bodyData = {};
  try { if (req.body && typeof req.body === 'object') bodyData = req.body; } catch (e) {}
  const includePortcos = bodyData.includePortcos || false;
  const crmStages = bodyData.crmStages || [];
  const keywords = bodyData.keywords || '';
  const excludeKeywords = bodyData.excludeKeywords || '';
  const filterSectors = bodyData.sectors || [];
  const filterStages = bodyData.stages || [];
  const filterGeos = bodyData.geos || [];
  const filterModels = bodyData.models || [];
  const filterSignals = bodyData.signals || [];
  const filterMaxRaised = bodyData.maxRaised || '';
  const filterMaxValuation = bodyData.maxValuation || '';
  const filterFoundedAfter = bodyData.foundedAfter || '';
  const filterMinTeam = bodyData.minTeam || '';
  const filterMaxTeam = bodyData.maxTeam || '';
  const filterNotes = bodyData.notes || '';
  const selectedSearchIds = (bodyData.selectedSearches || []).map(String);
  const selectedPortcos = bodyData.selectedPortcos || null; // null = all, [] = none
  const scanUser = bodyData.user || 'Mark';

  // Build filter context string for AI prompts
  const filterParts = [];
  if (filterSectors.length > 0) filterParts.push(`TARGET SECTORS: ${filterSectors.join(', ')}`);
  if (filterStages.length > 0) filterParts.push(`TARGET STAGES: ${filterStages.join(', ')}`);
  if (filterGeos.length > 0) filterParts.push(`TARGET GEOGRAPHY: ${filterGeos.join(', ')}`);
  if (filterModels.length > 0) filterParts.push(`BUSINESS MODELS: ${filterModels.join(', ')}`);
  if (filterSignals.length > 0) filterParts.push(`LOOK FOR SIGNALS: ${filterSignals.join(', ')}`);
  if (filterMaxRaised) filterParts.push(`MAX RAISED: ${filterMaxRaised}`);
  if (filterMaxValuation) filterParts.push(`MAX VALUATION: ${filterMaxValuation}`);
  if (filterFoundedAfter) filterParts.push(`FOUNDED AFTER: ${filterFoundedAfter}`);
  if (filterMinTeam) filterParts.push(`MIN TEAM SIZE: ${filterMinTeam}`);
  if (filterMaxTeam) filterParts.push(`MAX TEAM SIZE: ${filterMaxTeam}`);
  if (excludeKeywords) filterParts.push(`EXCLUDE companies matching: ${excludeKeywords}`);
  if (filterNotes) filterParts.push(`SPECIAL INSTRUCTIONS: ${filterNotes}`);
  const filterContext = filterParts.length > 0 ? '\n\nUSER SEARCH CRITERIA:\n' + filterParts.join('\n') : '';

  if (!anthropicKey) {
    safeWrite(`data: ${JSON.stringify({ error: 'Anthropic API key required' })}\n\n`);
    return res.end();
  }

  const tier = SCAN_TIERS[tierKey] || SCAN_TIERS.standard;
  const scanId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const scan = {
    id: scanId, status: 'scanning', startedAt: Date.now(), _cancelled: false,
    tier: { key: tierKey, ...tier },
    stats: { savedSearches: 0, totalCompanies: 0, sonnetPassed: 0, enriched: 0, deepScored: 0, topResults: 0, ddPushed: 0 },
    progress: `Starting ${tier.name} scan ($${tier.budget} budget)...`,
    results: null, _batches: [], user: scanUser,
    options: { includePortcos, crmStages, keywords, selectedSearches: selectedSearchIds },
  };
  global._deepScans[scanId] = scan;

  const keepalive = setInterval(() => { safeWrite(': keepalive\n\n'); try { scan.lastUpdatedAt = Date.now(); saveScansState(); } catch(e){} }, 5000);
  safeWrite(`data: ${JSON.stringify({ scanId })}\n\n`);

  const persistState = () => { try { saveScansState(); } catch (e) {} };

  const BUDGET_MAX = tier.budget;
  let budgetUsed = 0;
  const SONNET_COST_PER_BATCH = 0.12;
  const OPUS_COST_PER_COMPANY = 0.03;
  const HAIKU_COST_PER_BATCH = 0.02;

  const authHeaders = { apikey: harmonicKey, Accept: 'application/json' };

  // Build context from portcos and CRM companies for similarity scoring
  let similarityContext = '';
  try {
    const contextParts = [];

    if (includePortcos) {
      safeWrite(`: 📂 Loading portfolio companies for similarity context...\n\n`);
      const portcos = selectedPortcos && selectedPortcos.length > 0 ? selectedPortcos : PORTCO_LIST;
      safeWrite(`: 📂 Using ${portcos.length} portfolio companies\n\n`);
      contextParts.push(`PORTFOLIO COMPANIES (find similar to these):\n${portcos.map(d => `- ${d}`).join('\n')}`);
    }

    if (crmStages.length > 0) {
      safeWrite(`: 📋 Loading CRM companies from ${crmStages.join(', ')}...\n\n`);
      const airtableBase = process.env.AIRTABLE_BASE_ID;
      const airtableTable = process.env.AIRTABLE_TABLE || 'All Companies';
      const airtableToken = process.env.AIRTABLE_TOKEN;
      const crmCompanies = [];
      for (const stage of crmStages) {
        try {
          const formula = encodeURIComponent(`{CRM Stage} = "${stage}"`);
          const url = `https://api.airtable.com/v0/${airtableBase}/${encodeURIComponent(airtableTable)}?filterByFormula=${formula}&maxRecords=50&fields[]=Company&fields[]=Sector&fields[]=Company Link`;
          const r = await fetch(url, { headers: { Authorization: `Bearer ${airtableToken}` } });
          if (r.ok) {
            const data = await r.json();
            const names = (data.records || []).map(rec => {
              const f = rec.fields || {};
              return `${f.Company || '?'}${f.Sector ? ` (${f.Sector})` : ''}`;
            });
            if (names.length > 0) crmCompanies.push(`${stage}: ${names.join(', ')}`);
          }
        } catch (e) {}
      }
      if (crmCompanies.length > 0) {
        contextParts.push(`CRM PIPELINE COMPANIES (find similar to these):\n${crmCompanies.join('\n')}`);
      }
    }

    if (keywords) {
      contextParts.push(`PRIORITY KEYWORDS/CONCEPTS:\n${keywords}`);
    }

    if (contextParts.length > 0) {
      similarityContext = '\n\nADDITIONAL SEARCH CONTEXT:\n' + contextParts.join('\n\n') + '\n\nUse the above context to BOOST companies that are similar to our portfolio/pipeline or match our keywords. Companies resembling our existing interests should score higher.\n';
    }
  } catch (e) {
    console.error('[RecurringScan] Context building error:', e.message);
  }

  try {
    // ═══════════════════════════════════════════════
    // PHASE 1: Fetch ALL saved searches
    // ═══════════════════════════════════════════════
    scan.progress = 'Fetching saved searches from Harmonic...';
    safeWrite(`: 🔍 Fetching all saved searches...\n\n`);

    const searchesRes = await fetch(`${HARMONIC_BASE}/savedSearches`, { headers: authHeaders });
    if (!searchesRes.ok) throw new Error(`Harmonic saved searches failed: ${searchesRes.status}`);
    const searchesData = await searchesRes.json();
    const allSearches = (Array.isArray(searchesData) ? searchesData : (searchesData.results || [])).filter(s => {
      const type = (s.type || '').toUpperCase();
      return type !== 'PERSONS_LIST' && type !== 'PERSONS' && type !== 'PERSON' && type !== 'PEOPLE';
    });

    // Filter to selected searches if user chose specific ones
    let searchesToProcess = allSearches;
    if (selectedSearchIds.length > 0) {
      searchesToProcess = allSearches.filter(s => selectedSearchIds.includes(String(s.id)));
      safeWrite(`: 📋 Using ${searchesToProcess.length} of ${allSearches.length} searches (${allSearches.length - searchesToProcess.length} excluded by user)\n\n`);
      if (searchesToProcess.length === 0) {
        safeWrite(`: ⚠️ No matching searches — using all ${allSearches.length}\n\n`);
        searchesToProcess = allSearches;
      }
    }

    scan.stats.savedSearches = searchesToProcess.length;
    safeWrite(`: 📋 Processing ${searchesToProcess.length} saved searches...\n\n`);
    console.log(`[DeepScan ${scanId}] Processing ${searchesToProcess.length} of ${allSearches.length} saved searches`);

    // ═══════════════════════════════════════════════
    // PHASE 2: Fetch companies from saved searches
    // ═══════════════════════════════════════════════
    const allCompanies = [];
    const seenIds = new Set();
    const seenSet = new Set();

    // Exclude backburned companies from import phase (cheapest — never enter the funnel)
    for (const id of _backburnIdx.ids) { if (id) seenSet.add(String(id)); }
    // Per-user hide-for-me
    const _recurringHideIdx = buildUserHideIndex((scanUser || '').toLowerCase());
    if (_recurringHideIdx) {
      for (const id of _recurringHideIdx.ids) { if (id) seenSet.add(String(id)); }
    }

    // Only filter companies dismissed by THIS user, not all users
    try {
      const SEEN_FILE = path.join(SCAN_VOLUME, 'autoscan_seen.json');
      const seenData = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      const userKey = (scanUser || 'Mark').toLowerCase();
      // Find this user's dismissed list (check exact match and lowercase)
      for (const [k, arr] of Object.entries(seenData)) {
        if (k === '_version') continue;
        if (k.toLowerCase() === userKey && Array.isArray(arr)) {
          arr.forEach(id => seenSet.add(String(id)));
        }
      }
    } catch (e) {}

    for (let si = 0; si < searchesToProcess.length; si++) {
      if (scan._cancelled) break;
      const search = searchesToProcess[si];
      const searchName = search.name || search.title || `Search ${search.id}`;
      scan.progress = `Fetching search ${si + 1}/${searchesToProcess.length}: "${searchName}"`;
      safeWrite(`: 📡 [${si + 1}/${searchesToProcess.length}] Fetching "${searchName}"...\n\n`);

      try {
        let afterCursor = null;
        let page = 0;
        do {
          let url = `${HARMONIC_BASE}/savedSearches:results/${search.id}?size=500`;
          if (afterCursor) url += `&cursor=${encodeURIComponent(afterCursor)}`;

          let fetchRes = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 120000);
              fetchRes = await fetch(url, { headers: authHeaders, signal: controller.signal });
              clearTimeout(timeout);
              if (fetchRes.ok) break;
              fetchRes = null;
            } catch (e) { fetchRes = null; }
            if (attempt < 2) await sleep(2000);
          }
          if (!fetchRes || !fetchRes.ok) break;

          const data = await fetchRes.json();
          const batch = extractCompaniesFromSavedSearch(data);
          let newCount = 0;
          for (const c of batch) {
            const cid = String(c.id || c.entity_id || (c.entity_urn || '').split(':').pop());
            if (cid && !seenIds.has(cid) && !seenSet.has(cid)) {
              seenIds.add(cid);
              c._sourceSearch = searchName;
              allCompanies.push(c);
              newCount++;
            }
          }
          page++;
          safeWrite(`: 📡 [${si + 1}/${searchesToProcess.length}] "${searchName}" page ${page}: ${batch.length} fetched, ${newCount} new (${allCompanies.length} total)\n\n`);
          const pi = data.page_info || data.pageInfo || {};
          const hasNext = pi.has_next || pi.has_next_page || false;
          const nextCursor = pi.next || pi.end_cursor || null;
          if (batch.length === 0 || !hasNext || !nextCursor) break;
          afterCursor = nextCursor;
          await sleep(100);
        } while (page < 50);
      } catch (e) {
        console.error(`[RecurringScan] Search "${searchName}" error:`, e.message);
      }
    }

    // Backburn + per-user hide safety pass — drop anything matched by name/domain that slipped the ID seen-set
    {
      const beforeBurn = allCompanies.length;
      for (let i = allCompanies.length - 1; i >= 0; i--) {
        if (isBackburned(allCompanies[i]) || isHiddenForUser(allCompanies[i], _recurringHideIdx)) allCompanies.splice(i, 1);
      }
      if (beforeBurn !== allCompanies.length) {
        const dropped = beforeBurn - allCompanies.length;
        console.log(`[RecurringScan/Filter] Dropped ${dropped} (backburn+user-hide), ${allCompanies.length} remain`);
        safeWrite(`: 🚫 Filter removed ${dropped} companies (backburn + hide)\n\n`);
      }
    }

    scan.stats.totalCompanies = allCompanies.length;
    scan.stats.seenFiltered = seenSet.size;
    safeWrite(`: 📊 Total unique companies: ${allCompanies.length} from ${searchesToProcess.length} searches (${seenSet.size} previously seen excluded)\n\n`);
    console.log(`[DeepScan ${scanId}] Total unique companies: ${allCompanies.length} (${seenSet.size} seen excluded)`);

    // ═══════════════════════════════════════════════
    // PHASE 2b: Pre-filter by numeric criteria (saves AI tokens)
    // ═══════════════════════════════════════════════
    const preFilterCount = allCompanies.length;
    function parseAmount(str) {
      if (!str) return null;
      const cleaned = str.replace(/[,$\s]/g, '').toUpperCase();
      const m = cleaned.match(/^(\d+(?:\.\d+)?)(M|K|B)?$/);
      if (!m) return null;
      const n = parseFloat(m[1]);
      if (m[2] === 'B') return n * 1e9;
      if (m[2] === 'M') return n * 1e6;
      if (m[2] === 'K') return n * 1e3;
      return n;
    }
    const maxRaisedNum = parseAmount(filterMaxRaised);
    const foundedAfterNum = filterFoundedAfter ? parseInt(filterFoundedAfter) : null;
    const minTeamNum = filterMinTeam ? parseInt(filterMinTeam) : null;
    const maxTeamNum = filterMaxTeam ? parseInt(filterMaxTeam) : null;

    if (maxRaisedNum || foundedAfterNum || minTeamNum || maxTeamNum || excludeKeywords) {
      const exKw = excludeKeywords ? excludeKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : [];
      for (let i = allCompanies.length - 1; i >= 0; i--) {
        const c = allCompanies[i];
        let cut = false;
        if (maxRaisedNum && c.funding_total && c.funding_total > maxRaisedNum) cut = true;
        if (foundedAfterNum) {
          const yr = parseInt(c.founded_date || c.founded || '0');
          if (yr > 0 && yr < foundedAfterNum) cut = true;
        }
        if (minTeamNum && c.headcount && c.headcount < minTeamNum) cut = true;
        if (maxTeamNum && c.headcount && c.headcount > maxTeamNum) cut = true;
        if (exKw.length > 0) {
          const txt = ((c.name || '') + ' ' + (c.description || '')).toLowerCase();
          if (exKw.some(k => txt.includes(k))) cut = true;
        }
        if (cut) allCompanies.splice(i, 1);
      }
      const removed = preFilterCount - allCompanies.length;
      if (removed > 0) {
        scan.stats.preFiltered = removed;
        safeWrite(`: 🔢 Pre-filtered ${removed} companies by numeric/keyword criteria (${allCompanies.length} remaining)\n\n`);
      }
    }

    if (scan._cancelled) throw new Error('Cancelled');

    // ═══════════════════════════════════════════════
    // PHASE 3: Sonnet rapid pre-screen (traction-focused)
    // ═══════════════════════════════════════════════
    const preModelName = tier.preModel.includes('haiku') ? 'Haiku' : 'Sonnet';
    scan.progress = `${preModelName} pre-screening ${allCompanies.length} companies...`;
    safeWrite(`: 🧠 Starting ${preModelName} pre-screen on ${allCompanies.length} companies...\n\n`);

    // Sort: lowest funding first, stealth to back
    allCompanies.sort((a, b) => {
      const aS = (a.name || '').toLowerCase().includes('stealth') ? 1 : 0;
      const bS = (b.name || '').toLowerCase().includes('stealth') ? 1 : 0;
      if (aS !== bS) return aS - bS;
      return (a.funding_total || 0) - (b.funding_total || 0);
    });

    const PRE_BATCH = tier.preBatch;
    const preBatches = Math.ceil(allCompanies.length / PRE_BATCH);
    const sonnetPassIds = new Set();

    // Build minimal company text for pre-screen
    function miniCompanyText(companies) {
      return companies.map((c, i) => {
        const parts = [`${i + 1}. **${c.name || 'Unknown'}**`];
        if (c.description) parts.push(`   ${(c.description || '').slice(0, 200)}`);
        if (c.website || c.domain) parts.push(`   Web: ${c.website || c.domain}`);
        if (c.funding_total) parts.push(`   Raised: $${c.funding_total >= 1e6 ? (c.funding_total/1e6).toFixed(1)+'M' : (c.funding_total/1e3).toFixed(0)+'K'}`);
        if (c.funding_stage) parts.push(`   Stage: ${c.funding_stage}`);
        if (c.headcount) parts.push(`   Team: ${c.headcount}`);
        if (c.founded_date || c.founded) parts.push(`   Founded: ${c.founded_date || c.founded}`);
        if (c._sourceSearch) parts.push(`   Source: ${c._sourceSearch}`);
        return parts.join('\n');
      }).join('\n\n');
    }

    for (let bi = 0; bi < preBatches; bi++) {
      if (scan._cancelled) break;
      if (budgetUsed >= BUDGET_MAX * 0.6) {
        safeWrite(`: ⚠️ Budget guard: ${budgetUsed.toFixed(2)}/${BUDGET_MAX} — stopping pre-screen, keeping ${sonnetPassIds.size} passes\n\n`);
        break;
      }

      const batch = allCompanies.slice(bi * PRE_BATCH, (bi + 1) * PRE_BATCH);
      const batchText = miniCompanyText(batch);

      // Track which saved searches are in this batch
      const batchSources = [...new Set(batch.map(c => c._sourceSearch).filter(Boolean))];
      const sourceLabel = batchSources.length <= 2 ? batchSources.join(', ') : `${batchSources[0]} +${batchSources.length - 1} more`;
      scan.progress = `Pre-screen batch ${bi + 1}/${preBatches} — ${sonnetPassIds.size} passed — ${sourceLabel}`;
      safeWrite(`: 🔬 Pre-screen batch ${bi + 1}/${preBatches} (${batch.length} companies, ${sonnetPassIds.size} passed) — from: ${sourceLabel}\n\n`);

      try {
        const prePrompt = `You are a rapid deal screener for Daxos Capital, a seed-stage angel fund ($100K-$250K checks).

TASK: For each company, output ONE line: CompanyName — PASS or CUT — [3-5 word reason]

DAXOS SECTORS (strong bias toward these):
• Crypto, DeFi, blockchain infrastructure, exchanges
• AI tools, AI infrastructure, developer platforms
• Fintech, payments, lending, financial data
• Prediction markets, betting, gaming platforms

PASS criteria (must meet 2+):
- In or adjacent to a Daxos sector above
- Post-revenue or measurable user traction (web traffic, users, growth)
- Low funding (<$5M raised) with real product, not vaporware
- Novel/disruptive product with clear differentiation
- Strong founder signal (ex-FAANG, YC, top-tier, domain expert)

AUTO-CUT:
- NOT in any Daxos sector and no clear adjacency
- Stealth/pre-launch with no product
- VC funds, accelerators, consulting/services firms
- >$20M raised (too late for seed)
- AI wrapper with no proprietary tech or data
- Enterprise SaaS with long sales cycles
- Biotech, cleantech, hardware-only needing $50M+
- No website and no traction signals

TARGET: Pass ~8-12% ONLY. Be extremely selective. Wrong sector = CUT even if great company.
${filterContext}
${similarityContext}
COMPANIES:
${batchText}`;

        const sRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: tier.preModel, max_tokens: 4000, messages: [{ role: 'user', content: prePrompt }] }),
        });

        budgetUsed += tier.preModel.includes('haiku') ? HAIKU_COST_PER_BATCH : SONNET_COST_PER_BATCH;

        if (sRes.ok) {
          const sData = await sRes.json();
          const sText = sData.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

          const passMatches = sText.matchAll(/([^\n—\-]+?)\s*[—\-–]\s*PASS/gi);
          for (const m of passMatches) {
            const name = m[1].trim().replace(/\*\*/g, '').replace(/^\d+\.\s*/, '').toLowerCase().trim();
            if (name.length > 1) {
              // Find matching company index to track
              const matchIdx = batch.findIndex(c => (c.name || '').toLowerCase().trim() === name ||
                (c.name || '').toLowerCase().replace(/\s*\(.*?\)/g, '').trim() === name);
              if (matchIdx >= 0) sonnetPassIds.add(bi * PRE_BATCH + matchIdx);
              else {
                // Fuzzy match
                const fuzzyIdx = batch.findIndex(c => {
                  const cn = (c.name || '').toLowerCase().trim();
                  return cn.includes(name) || name.includes(cn);
                });
                if (fuzzyIdx >= 0) sonnetPassIds.add(bi * PRE_BATCH + fuzzyIdx);
              }
            }
          }

          // Stream all verdicts with reasons + collect batch data
          const batchCompanies = [];
          const lines = sText.split('\n').filter(l => l.includes('PASS') || l.includes('CUT'));
          for (const line of lines) {
            const isPASS = line.includes('PASS');
            const parts = line.split(/\s*[—\-–]\s*/);
            const compName = (parts[0] || '').replace(/\*\*/g, '').replace(/^\d+\.\s*/, '').trim().slice(0, 35);
            const reason = (parts[2] || '').trim().slice(0, 60);
            if (compName.length > 2) {
              safeWrite(`: ${isPASS ? '✅' : '❌'} ${compName}${reason ? ' — ' + reason : ''}\n\n`);
              const origCard = batch.find(c => (c.name || '').toLowerCase().includes(compName.toLowerCase()) || compName.toLowerCase().includes((c.name || '').toLowerCase()));
              batchCompanies.push({ name: compName, verdict: isPASS ? 'PASS' : 'CUT', reason, website: origCard?.website || origCard?.domain || '', logo_url: origCard?.logo_url || '', funding_stage: origCard?.funding_stage || '' });
            }
          }
          scan._batches.push({ phase: 'prescreen', batchNum: bi + 1, totalBatches: preBatches, sources: batchSources, companies: batchCompanies, passCount: batchCompanies.filter(c => c.verdict === 'PASS').length, timestamp: Date.now() });
        }
      } catch (e) {
        console.error(`[RecurringScan] Pre-screen batch ${bi + 1} error:`, e.message);
      }
      await sleep(300);
    }

    const survivors = [...sonnetPassIds].map(idx => allCompanies[idx]).filter(Boolean);
    scan.stats.sonnetPassed = survivors.length;
    safeWrite(`: ✅ Pre-screen complete: ${survivors.length} of ${allCompanies.length} passed (${((survivors.length / allCompanies.length) * 100).toFixed(1)}%)\n\n`);
    console.log(`[RecurringScan] Pre-screen: ${survivors.length}/${allCompanies.length} passed`);

    if (scan._cancelled) throw new Error('Cancelled');

    // ═══════════════════════════════════════════════
    // PHASE 4: GQL enrichment of survivors
    // ═══════════════════════════════════════════════
    scan.progress = `Enriching ${survivors.length} companies with full data...`;
    safeWrite(`: 📥 Enriching ${survivors.length} companies via Harmonic GQL...\n\n`);

    const companyIds = survivors.map(c => parseInt(c.id || c.entity_id || (c.entity_urn || '').split(':').pop())).filter(id => !isNaN(id) && id > 0);
    let enrichedCards = [];
    if (companyIds.length > 0 && harmonicKey) {
      enrichedCards = (await gqlEnrichCompanies(companyIds, harmonicKey)).map(c => gqlToCard(c));
      // Merge source search info
      enrichedCards.forEach(card => {
        const orig = survivors.find(s => {
          const sid = String(s.id || s.entity_id || (s.entity_urn || '').split(':').pop());
          return sid === String(card.id);
        });
        if (orig) card._sourceSearch = orig._sourceSearch;
      });
    }

    scan.stats.enriched = enrichedCards.length;
    safeWrite(`: 📊 Enriched ${enrichedCards.length} companies\n\n`);

    if (scan._cancelled) throw new Error('Cancelled');

    // ═══════════════════════════════════════════════
    // PHASE 5: Sonnet traction-focused scoring (post-enrichment)
    // ═══════════════════════════════════════════════
    // Filter out VCs, wrong-stage, etc
    const filtered = enrichedCards.filter(c => {
      const desc = ((c.description || '') + ' ' + (c.tags || []).join(' ')).toLowerCase();
      if (/\b(venture capital|vc firm|private equity|hedge fund|asset management|family office|accelerator|incubator)\b/.test(desc)) return false;
      if ((c.funding_total || 0) > 20000000) return false;
      if ((c.name || '').toLowerCase().includes('stealth')) return false;
      return true;
    });

    scan.stats.filtered = filtered.length;
    safeWrite(`: 🔽 Filtered to ${filtered.length} (removed ${enrichedCards.length - filtered.length} VCs/late-stage/stealth)\n\n`);

    // Sort by traction signals — web traffic first
    filtered.sort((a, b) => {
      const aWeb = a.traction?.webTraffic || 0;
      const bWeb = b.traction?.webTraffic || 0;
      const aGrowth = a.traction?.webGrowth30d || 0;
      const bGrowth = b.traction?.webGrowth30d || 0;
      return (bWeb + bGrowth * 1000) - (aWeb + aGrowth * 1000);
    });

    // Sonnet deep screen with full enriched data
    // Only fetch portfolio context if user selected CRM stages — otherwise it biases scoring
    const portfolioContext = (crmStages && crmStages.length > 0) ? await fetchPortfolioContext() : '';
    const SCREEN_BATCH = tier.screenBatch;
    const screenBatches = Math.ceil(filtered.length / SCREEN_BATCH);
    const screenPassNames = new Set();
    let screenAnalysis = '';

    scan.progress = `Sonnet scoring ${filtered.length} enriched companies...`;

    function buildCompanyTextRecurring(cards, startIdx) {
      return cards.map((c, i) => {
        const parts = [`${startIdx + i + 1}. **${c.name}**`];
        if (c._sourceSearch) parts.push(`   Source Search: ${c._sourceSearch}`);
        if (c.description) parts.push(`   Desc: ${c.description.slice(0, 300)}`);
        if (c.website) parts.push(`   Web: ${c.website}`);
        if (c.funding_stage) parts.push(`   Stage: ${c.funding_stage}`);
        if (c.funding_total) parts.push(`   Raised: $${c.funding_total >= 1e6 ? (c.funding_total/1e6).toFixed(1)+'M' : (c.funding_total/1e3).toFixed(0)+'K'}`);
        if (c.funding_date) parts.push(`   Last Funding: ${c.funding_date}`);
        if (c.headcount) parts.push(`   Team: ${c.headcount}`);
        if (c.location) parts.push(`   Location: ${c.location}`);
        if (c.founded) parts.push(`   Founded: ${c.founded}`);
        if (c.investors?.length) parts.push(`   Investors: ${c.investors.join(', ')}`);
        if (c.founders?.length) {
          c.founders.forEach(f => {
            const fl = [`   👤 ${f.name}`];
            if (f.headline) fl.push(`      ${f.headline}`);
            if (f.careerPath) fl.push(`      Career: ${f.careerPath}`);
            if (f.education?.length) fl.push(`      Edu: ${f.education.map(e => `${e.degree || ''} @ ${e.school}`.trim()).join(', ')}`);
            if (f.highlights?.length) fl.push(`      Notable: ${f.highlights.join('; ')}`);
            parts.push(fl.join('\n'));
          });
        }
        if (c.founder_prior_companies?.length) parts.push(`   Founder alumni: ${c.founder_prior_companies.join(', ')}`);
        if (c.highlights?.length) parts.push(`   Highlights: ${c.highlights.slice(0, 3).join('; ')}`);
        const t = c.traction || {};
        const tm = [];
        if (t.webTraffic) tm.push(`Web: ${t.webTraffic}/mo`);
        if (t.webGrowth30d) tm.push(`Web30d: ${t.webGrowth30d > 0 ? '+' : ''}${t.webGrowth30d}%`);
        if (t.webGrowth90d) tm.push(`Web90d: ${t.webGrowth90d > 0 ? '+' : ''}${t.webGrowth90d}%`);
        if (t.hcGrowth30d) tm.push(`HC30d: ${t.hcGrowth30d > 0 ? '+' : ''}${t.hcGrowth30d}%`);
        if (tm.length) parts.push(`   📈 Traction: ${tm.join(', ')}`);
        return parts.join('\n');
      }).join('\n\n');
    }

    for (let si = 0; si < screenBatches; si++) {
      if (scan._cancelled) break;
      if (budgetUsed >= BUDGET_MAX * 0.75) {
        safeWrite(`: ⚠️ Budget ${budgetUsed.toFixed(2)}/${BUDGET_MAX} — stopping Sonnet screen\n\n`);
        break;
      }

      const batch = filtered.slice(si * SCREEN_BATCH, (si + 1) * SCREEN_BATCH);
      const batchText = buildCompanyTextRecurring(batch, si * SCREEN_BATCH);

      const scoreSources = [...new Set(batch.map(c => c._sourceSearch).filter(Boolean))];
      const scoreSourceLabel = scoreSources.length <= 2 ? scoreSources.join(', ') : `${scoreSources[0]} +${scoreSources.length - 1} more`;
      scan.progress = `Scoring batch ${si + 1}/${screenBatches} — ${screenPassNames.size} winners — ${scoreSourceLabel}`;
      safeWrite(`: 🎯 Scoring batch ${si + 1}/${screenBatches} (${screenPassNames.size} winners) — from: ${scoreSourceLabel}\n\n`);

      try {
        const screenPrompt = `You are a senior deal analyst for Daxos Capital, a seed-stage angel fund ($100K-$250K checks, Pre-Seed/Seed only).

${portfolioContext ? portfolioContext : ''}

MISSION: Score each company 1-10 based on investability RIGHT NOW at seed stage.

DAXOS THESIS — We invest in:
• Crypto/blockchain infrastructure, DeFi, exchanges, prediction markets
• AI infrastructure, developer tools, applied AI with real users
• Fintech, payments, lending, financial data
• Betting/gaming platforms with traction
• Companies with REAL measurable traction (web traffic, users, revenue) at low funding (<$5M raised)

SCORING GUIDE:
9-10: PERFECT FIT — Daxos thesis sector + strong traction + great team + low funding. Call founder today.
7-8: STRONG — Good sector fit, promising traction signals, worth investigating.
5-6: INTERESTING — Decent company but wrong stage, or weak traction. Non-thesis sector companies usually land here.
7-8 for NON-THESIS: ALLOWED if truly exceptional — explosive traction, elite founders, measurable revenue at low funding. The bar is much higher than for thesis-fit companies.
3-4: PASS — Not Daxos material. Too much funding, no traction, or boring product.
1-2: HARD PASS — Services company, dead product, or completely wrong for angel/seed.

CRITICAL FILTERS — Auto-score 3 or below:
• Company raised >$10M (too late for us)
• Pure consulting/services/agency
• AI wrapper with no proprietary tech or data moat
• No product launched, no users, just a landing page
• Enterprise SaaS with long sales cycles (not our style)
• Biotech, hardware-only, or deep science requiring $50M+ to reach market

FORMAT (one per company):
**CompanyName** — Score: X/10
Reason: [2-3 sentences — focus on: sector fit, traction evidence, founder signal, stage fit]

BE HARSH. Most companies should score 3-6. A 7+ is genuinely exciting for Daxos.
${filterContext}
${similarityContext}
COMPANIES:
${batchText}`;

        const sRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: tier.screenModel, max_tokens: 4000, messages: [{ role: 'user', content: screenPrompt }] }),
        });
        budgetUsed += SONNET_COST_PER_BATCH;

        if (sRes.ok) {
          const sData = await sRes.json();
          const sText = sData.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          screenAnalysis += sText + '\n\n';

          // Parse scores — find companies scoring 7+
          const scoreRegex = /\*\*([^*]+)\*\*\s*[—\-–]\s*Score:\s*(\d+)/gi;
          let match;
          while ((match = scoreRegex.exec(sText)) !== null) {
            const name = match[1].trim();
            const score = parseInt(match[2]);
            if (score >= 7) screenPassNames.add(name.toLowerCase());
          }

          // Stream all scored companies + collect batch data
          const scoreBatchCompanies = [];
          const scoreLines = sText.split(/\n/).filter(l => /Score:\s*\d+/i.test(l));
          for (const line of scoreLines) {
            const cn = (line.match(/\*\*([^*]+)\*\*/) || [])[1] || '';
            const sc = parseInt((line.match(/Score:\s*(\d+)/i) || [])[1] || '0');
            if (!cn) continue;
            const reasonIdx = sText.indexOf(line);
            const afterScore = sText.slice(reasonIdx + line.length, reasonIdx + line.length + 200);
            const reasonMatch = afterScore.match(/Reason:\s*([^\n]+)/i);
            const reason = reasonMatch ? reasonMatch[1].trim().slice(0, 80) : '';
            const emoji = sc >= 9 ? '🌟' : sc >= 7 ? '🏆' : sc >= 5 ? '📊' : '📉';
            safeWrite(`: ${emoji} ${cn} — ${sc}/10${reason ? ' — ' + reason : ''}\n\n`);
            const origCard = batch.find(c => { const n = (c.name || '').toLowerCase(); return n === cn.toLowerCase() || n.includes(cn.toLowerCase()) || cn.toLowerCase().includes(n); });
            scoreBatchCompanies.push({ name: cn, score: sc, reason, website: origCard?.website || '', logo_url: origCard?.logo_url || '', funding_stage: origCard?.funding_stage || '', funding_total: origCard?.funding_total || 0, description: (origCard?.description || '').slice(0, 150) });
          }
          scan._batches.push({ phase: 'scoring', batchNum: si + 1, totalBatches: screenBatches, sources: scoreSources, companies: scoreBatchCompanies, winnerCount: scoreBatchCompanies.filter(c => c.score >= 7).length, timestamp: Date.now() });
        }
      } catch (e) {
        console.error(`[RecurringScan] Screen batch ${si + 1} error:`, e.message);
      }
      await sleep(300);
    }

    // Match screen passes to enriched cards
    const topCandidates = filtered.filter(c => {
      const n = (c.name || '').toLowerCase().trim();
      return screenPassNames.has(n) || [...screenPassNames].some(p => p.includes(n) || n.includes(p));
    });

    scan.stats.scored = topCandidates.length;
    safeWrite(`: 🎖️ Sonnet scoring complete: ${topCandidates.length} companies scored 7+ out of ${filtered.length}\n\n`);
    console.log(`[RecurringScan] Sonnet screen: ${topCandidates.length} scored 7+ from ${filtered.length}`);

    if (scan._cancelled) throw new Error('Cancelled');

    // ═══════════════════════════════════════════════
    // PHASE 6: Opus deep analysis — top ~100 companies
    // ═══════════════════════════════════════════════
    const deepModelName = tier.deepModel.includes('opus') ? 'Opus' : 'Sonnet';
    const opusCap = Math.min(topCandidates.length, tier.deepMax);
    const opusBatch = topCandidates.slice(0, opusCap);
    const remainingBudget = BUDGET_MAX - budgetUsed;
    const costPerDeep = tier.deepModel.includes('opus') ? OPUS_COST_PER_COMPANY : SONNET_COST_PER_BATCH / 15;
    const maxOpusCompanies = Math.min(opusCap, Math.floor(remainingBudget / costPerDeep));

    scan.progress = `${deepModelName} deep analysis on top ${maxOpusCompanies} companies...`;
    safeWrite(`: 🧠 Starting ${deepModelName} deep analysis on ${maxOpusCompanies} companies (budget remaining: $${remainingBudget.toFixed(2)})\n\n`);

    const OPUS_DEEP_BATCH = tier.deepBatch;
    const opusDeepBatches = Math.ceil(maxOpusCompanies / OPUS_DEEP_BATCH);
    const deepResults = [];

    for (let oi = 0; oi < opusDeepBatches; oi++) {
      if (scan._cancelled) break;
      if (budgetUsed >= BUDGET_MAX) {
        safeWrite(`: 💰 Budget cap reached ($${budgetUsed.toFixed(2)}/${BUDGET_MAX})\n\n`);
        break;
      }

      const batch = opusBatch.slice(oi * OPUS_DEEP_BATCH, (oi + 1) * OPUS_DEEP_BATCH);
      const batchText = buildCompanyTextRecurring(batch, oi * OPUS_DEEP_BATCH);

      scan.progress = `Opus batch ${oi + 1}/${opusDeepBatches} — ${deepResults.length} deep-scored`;
      safeWrite(`: 🔬 Opus deep batch ${oi + 1}/${opusDeepBatches} (${batch.length} companies)\n\n`);

      try {
        const deepPrompt = `You are Daxos Capital's top deal analyst performing DEEP due diligence on seed-stage companies.

CONTEXT: These ${batch.length} companies scored 7+ from screening ${allCompanies.length} total companies. They are the top ~1%.

${portfolioContext ? portfolioContext : ''}

DAXOS PROFILE:
- Seed-stage angel fund, $100K-$250K checks
- Core sectors: Crypto/DeFi, AI tools, fintech, prediction markets, betting/gaming
- We want: real traction at low funding, novel products, strong founders
- We pass on: enterprise SaaS, services, hardware-only, companies that raised $10M+

For EACH company, provide conviction-level analysis:

1. **Product & Moat**: What they build, what's genuinely novel, defensibility
2. **Traction**: Web traffic growth, user count signals, revenue indicators — BE SPECIFIC with numbers from the data
3. **Founders**: Prior companies, background quality, domain expertise
4. **Market Timing**: Why this product now, what macro trend enables it
5. **Daxos Fit**: HONEST assessment — does this match crypto/AI/fintech/betting thesis? Or is it a stretch?
6. **Risk**: Primary concern that could kill this investment

SCORING:
9-10 = "I'd wire money today" — perfect thesis fit + explosive traction + elite team
7-8 = "Take the meeting" — strong on 2+ dimensions, worth investigating
5-6 = "Interesting but not for us" — good company, wrong fit for Daxos
Below 5 = "How did this get here?" — should have been filtered earlier

FORMAT:
### CompanyName — Final Score: X/10 (Confidence: High/Medium/Low)
[150-250 word investment memo]
**Key Signal**: [single most compelling data point with specific numbers]
**Risk**: [primary concern]

DO NOT inflate scores. We are a THESIS-DRIVEN fund, not a generalist. Non-thesis companies USUALLY score 5-6, BUT can score 7-8 if they show genuinely exceptional signals: explosive traction metrics (10x growth, thousands of users at minimal funding), elite founders (ex-CTO of unicorn, serial exiter), or measurable revenue growth that speaks for itself. The quality bar for a non-thesis 7+ is much higher than for thesis-fit companies.
${filterContext}
${similarityContext}
COMPANIES:
${batchText}`;

        const oRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: tier.deepModel, max_tokens: 8000, messages: [{ role: 'user', content: deepPrompt }] }),
        });
        budgetUsed += batch.length * costPerDeep;

        if (oRes.ok) {
          const oData = await oRes.json();
          const oText = oData.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

          // Parse each company's deep analysis
          const sections = oText.split(/###\s+/).filter(s => s.trim());
          for (const section of sections) {
            const nameMatch = section.match(/^([^—\n]+?)\s*[—\-–]\s*Final Score:\s*(\d+)\/10/i);
            if (nameMatch) {
              const companyName = nameMatch[1].trim().replace(/\*\*/g, '');
              const score = parseInt(nameMatch[2]);
              const confMatch = section.match(/Confidence:\s*(High|Medium|Low)/i);
              const confidence = confMatch ? confMatch[1] : 'Medium';

              // Find matching card
              const card = batch.find(c => {
                const cn = (c.name || '').toLowerCase();
                const pn = companyName.toLowerCase();
                return cn === pn || cn.includes(pn) || pn.includes(cn);
              });

              deepResults.push({
                name: companyName,
                score,
                confidence,
                analysis: section.trim(),
                card: card || null,
                _sourceSearch: card?._sourceSearch || '',
              });

              // Extract key signal for streaming
              const keySignal = (section.match(/\*\*Key Signal\*\*:\s*([^\n]+)/i) || [])[1] || '';
              const riskFlag = (section.match(/\*\*Risk\*\*:\s*([^\n]+)/i) || [])[1] || '';
              const emoji = score >= 9 ? '🌟' : score >= 7 ? '⭐' : '📋';
              let detail = `${emoji} ${companyName} — ${score}/10 (${confidence})`;
              if (card?.funding_stage) detail += ` · ${card.funding_stage}`;
              if (card?.funding_total) detail += ` · $${card.funding_total >= 1e6 ? (card.funding_total/1e6).toFixed(1)+'M' : (card.funding_total/1e3).toFixed(0)+'K'}`;
              if (keySignal) detail += `\n:    💡 ${keySignal.slice(0, 100)}`;
              if (riskFlag && score >= 7) detail += `\n:    ⚠️ ${riskFlag.slice(0, 80)}`;
              safeWrite(`: ${detail}\n\n`);
            }
          }
          // Store deep batch data
          const deepBatchCompanies = deepResults.slice(-batch.length).map(r => ({
            name: r.name, score: r.score, confidence: r.confidence, website: r.card?.website || '', logo_url: r.card?.logo_url || '',
            funding_stage: r.card?.funding_stage || '', funding_total: r.card?.funding_total || 0, description: (r.card?.description || '').slice(0, 150),
            keySignal: (r.analysis?.match(/\*\*Key Signal\*\*:\s*([^\n]+)/i) || [])[1]?.slice(0, 100) || '',
          }));
          scan._batches.push({ phase: 'deep', batchNum: oi + 1, totalBatches: opusDeepBatches, companies: deepBatchCompanies, timestamp: Date.now() });
        }
      } catch (e) {
        console.error(`[RecurringScan] Opus batch ${oi + 1} error:`, e.message);
      }
      await sleep(500);
    }

    // Sort deep results by score
    deepResults.sort((a, b) => b.score - a.score || (a.confidence === 'High' ? -1 : 1));
    scan.stats.deepScored = deepResults.length;
    scan.stats.topResults = deepResults.filter(r => r.score >= 7).length;

    // ═══════════════════════════════════════════════
    // PHASE 7: Save results
    // ═══════════════════════════════════════════════
    // Push top N results to DD/vetting pipeline
    const ddCount = Math.min(tier.ddPush, deepResults.filter(r => r.score >= 6).length);
    const ddCompanies = deepResults.slice(0, ddCount).map(r => ({
      id: r.card?.id || 0,
      name: (r.name || '').replace(/^\d+\.\s*/, ''),
      website: r.card?.website || '',
      description: r.card?.description || '',
      logo_url: r.card?.logo_url || '',
      funding_total: r.card?.funding_total || 0,
      funding_stage: r.card?.funding_stage || '',
      headcount: r.card?.headcount || 0,
      location: r.card?.location || '',
      _score: r.score,
      _confidence: r.confidence,
      _analysis: (r.analysis || '').slice(0, 500),
      _sourceSearch: r._sourceSearch || '',
    }));

    let ddPushed = 0;
    if (ddCompanies.length > 0) {
      try {
        const vettingData = loadVetting();
        const vetting = vettingData.companies || [];
        const existingNames = new Set(vetting.map(v => (v.name || '').toLowerCase()));
        for (const co of ddCompanies) {
          if (!existingNames.has(co.name.toLowerCase())) {
            vetting.push({ ...co, addedAt: Date.now(), source: 'recurring-scan', votes: {}, dismissed: false, hiddenBy: [] });
            ddPushed++;
          }
        }
        saveVetting({ ...vettingData, companies: vetting });
        safeWrite(`: 📤 Pushed ${ddPushed} companies to DD pipeline\n\n`);
      } catch (e) {
        console.error('[RecurringScan] DD push error:', e.message);
      }
    }

    scan.stats.ddPushed = ddPushed;

    // Flatten card data into each result so frontend can access company.id, company.website etc directly
    let flattenedResults = deepResults.map(r => {
      if (!r.card) return r;
      const { card, ...rest } = r;
      return { ...card, ...rest, name: (rest.name || card.name || '').replace(/^\d+\.\s*/, ''), _score: r.score, score: r.score, confidence: r.confidence, analysis: r.analysis, _sourceSearch: r._sourceSearch };
    });
    // Final backburn + per-user-hide pass (defense-in-depth — covers Backburn/hide flips mid-scan)
    flattenedResults = filterBackburn(flattenedResults);
    flattenedResults = filterUserHidden(flattenedResults, _recurringHideIdx);

    const finalResults = {
      results: flattenedResults,
      screenAnalysis,
      stats: scan.stats,
      budgetUsed: budgetUsed.toFixed(2),
      timestamp: new Date().toISOString(),
      duration: Math.round((Date.now() - scan.startedAt) / 1000),
      tier: { key: tierKey, name: tier.name, cost: tier.cost, ddPush: tier.ddPush },
      options: { includePortcos, crmStages, keywords, excludeKeywords, sectors: filterSectors, stages: filterStages, geos: filterGeos, models: filterModels, signals: filterSignals, maxRaised: filterMaxRaised, foundedAfter: filterFoundedAfter, notes: filterNotes },
      user: scanUser,
    };

    const RESULTS_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'recurring_scan_results.json');
    try { fs.writeFileSync(RESULTS_FILE, JSON.stringify(finalResults, null, 2)); } catch (e) {}

    // Append to history (keep last 20)
    try {
      const history = loadRecurringScanHistory();
      history.unshift({ ...finalResults, personId: (scanUser || 'mark').toLowerCase(), profileName: `${tier.name} Scan` });
      saveRecurringScanHistory(history);
    } catch (e) {}

    scan.status = 'done';
    scan.progress = `Complete — ${deepResults.length} deep-scored, ${scan.stats.topResults} rated 7+, ${ddPushed} pushed to DD`;
    scan.results = finalResults;
    scan.finishedAt = Date.now();
    persistState();
    cleanupOldScans();

    safeWrite(`: 🏁 SCAN COMPLETE\n\n`);
    safeWrite(`: 📊 ${allCompanies.length} sourced → ${survivors.length} pre-screened → ${topCandidates.length} scored 7+ → ${deepResults.length} deep-analyzed\n\n`);
    safeWrite(`: 📤 ${ddPushed} top companies pushed to DD pipeline\n\n`);
    safeWrite(`: 💰 Budget used: $${budgetUsed.toFixed(2)} / $${BUDGET_MAX}\n\n`);
    safeWrite(`: ⏱️ Duration: ${Math.round((Date.now() - scan.startedAt) / 60000)} minutes\n\n`);
    safeWrite(`data: ${JSON.stringify(finalResults)}\n\n`);

  } catch (e) {
    if (e.message === 'Cancelled') {
      scan.status = 'cancelled';
      scan.progress = 'Cancelled by user';
      scan.finishedAt = Date.now();
      safeWrite(`data: ${JSON.stringify({ error: 'Scan cancelled' })}\n\n`);
    } else {
      console.error('[RecurringScan] Fatal error:', e.message);
      scan.status = 'error';
      scan.progress = `Error: ${e.message}`;
      scan.finishedAt = Date.now();
      safeWrite(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    }
    try { saveScansState(); } catch (e) {}
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

// ==========================================
// REACHOUTS — Multi-platform DM tracker
// Server-side 24/7 polling + extension sync
// ==========================================

const reachoutsData = loadReachoutsData();
const reachoutsCredentials = loadReachoutsCreds();

const pollingIntervals = {};

function mergeReachoutsMessages(platform, newMessages) {
  const existingByKey = {};
  reachoutsData.messages.forEach(m => {
    existingByKey[`${m.platform}:${m.conversationId}`] = m;
  });
  newMessages.forEach(msg => {
    const key = `${platform}:${msg.conversationId}`;
    const existing = existingByKey[key];
    existingByKey[key] = {
      platform,
      conversationId: msg.conversationId,
      senderName: msg.senderName || existing?.senderName || 'Unknown',
      senderAvatar: msg.senderAvatar || existing?.senderAvatar || null,
      lastMessage: msg.lastMessage || existing?.lastMessage || '',
      timestamp: msg.timestamp || new Date().toISOString(),
      unread: msg.unread !== undefined ? msg.unread : true,
      url: msg.url || existing?.url || null,
      markedRead: existing?.markedRead || false,
    };
  });
  reachoutsData.messages = Object.values(existingByKey);
  reachoutsData.lastSync[platform] = new Date().toISOString();
  saveReachoutsData(reachoutsData);
}

function startPolling(platform, fn, intervalMs) {
  if (pollingIntervals[platform]) clearInterval(pollingIntervals[platform]);
  console.log(`[Reachouts] Starting ${platform} polling every ${intervalMs / 1000}s`);
  fn(); // run immediately
  pollingIntervals[platform] = setInterval(fn, intervalMs);
}

function stopPolling(platform) {
  if (pollingIntervals[platform]) {
    clearInterval(pollingIntervals[platform]);
    delete pollingIntervals[platform];
    console.log(`[Reachouts] Stopped ${platform} polling`);
  }
}

// ---- GMAIL (OAuth2 REST API) ----

async function pollGmail() {
  const creds = reachoutsCredentials.gmail;
  if (!creds) return;
  try {
    // Refresh access token
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      console.error('[Reachouts/Gmail] Token refresh failed:', tokenData.error);
      reachoutsData.platformStatus.gmail = { connected: false, error: tokenData.error || 'Token refresh failed' };
      return;
    }
    const accessToken = tokenData.access_token;
    const headers = { Authorization: `Bearer ${accessToken}` };

    // Fetch unread messages (DMs = messages in inbox that are unread)
    const listResp = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread+in%3Ainbox&maxResults=20',
      { headers }
    );
    const listData = await listResp.json();
    const messageIds = (listData.messages || []).map(m => m.id);

    const messages = [];
    for (const id of messageIds.slice(0, 15)) {
      const msgResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers }
      );
      const msgData = await msgResp.json();
      const getHeader = (name) => msgData.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
      const from = getHeader('From');
      const subject = getHeader('Subject');
      const date = getHeader('Date');

      messages.push({
        conversationId: `gmail-${msgData.threadId || id}`,
        senderName: from.replace(/<.*>/, '').trim() || from,
        lastMessage: subject,
        timestamp: date ? new Date(date).toISOString() : new Date().toISOString(),
        unread: true,
        url: `https://mail.google.com/mail/u/0/#inbox/${msgData.threadId || id}`,
      });
    }

    mergeReachoutsMessages('gmail', messages);
    reachoutsData.platformStatus.gmail = { connected: true, lastSync: new Date().toISOString(), mode: 'api' };
    console.log(`[Reachouts/Gmail] Synced ${messages.length} unread messages`);
  } catch (e) {
    console.error('[Reachouts/Gmail] Poll error:', e.message);
    reachoutsData.platformStatus.gmail = { connected: true, lastSync: reachoutsData.lastSync.gmail, error: e.message };
  }
}

// Gmail OAuth flow
app.post('/api/reachouts/connect/gmail', (req, res) => {
  const { clientId, clientSecret, refreshToken } = req.body;
  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(400).json({ error: 'clientId, clientSecret, and refreshToken required' });
  }
  reachoutsCredentials.gmail = { clientId, clientSecret, refreshToken };
  saveReachoutsCreds(reachoutsCredentials);
  startPolling('gmail', pollGmail, 120000); // every 2 min
  res.json({ ok: true, message: 'Gmail connected — polling every 2 minutes' });
});

app.get('/api/reachouts/connect/gmail/auth-url', (req, res) => {
  const { clientId, redirectUri } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const redirect = redirectUri || `https://pigeon-api.up.railway.app/api/reachouts/callback/gmail`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent('https://www.googleapis.com/auth/gmail.readonly')}` +
    `&access_type=offline&prompt=consent`;
  res.json({ authUrl: url });
});

app.get('/api/reachouts/callback/gmail', async (req, res) => {
  const { code, clientId, clientSecret } = req.query;
  const cid = clientId || reachoutsCredentials.gmail?.clientId;
  const csec = clientSecret || reachoutsCredentials.gmail?.clientSecret;
  if (!code || !cid || !csec) {
    return res.status(400).send('Missing code or credentials. Set clientId and clientSecret first via /api/reachouts/connect/gmail');
  }
  try {
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: cid,
        client_secret: csec,
        redirect_uri: `https://pigeon-api.up.railway.app/api/reachouts/callback/gmail`,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenResp.json();
    if (tokenData.refresh_token) {
      reachoutsCredentials.gmail = { clientId: cid, clientSecret: csec, refreshToken: tokenData.refresh_token };
      saveReachoutsCreds(reachoutsCredentials);
      startPolling('gmail', pollGmail, 120000);
      res.send('<h2>Gmail connected!</h2><p>You can close this tab. Polling started.</p>');
    } else {
      res.status(400).send(`<h2>Error</h2><p>${tokenData.error || 'No refresh token received'}</p>`);
    }
  } catch (e) {
    res.status(500).send(`<h2>Error</h2><p>${e.message}</p>`);
  }
});

// ---- TELEGRAM (Bot API) ----

let telegramOffset = 0;

async function pollTelegram() {
  const creds = reachoutsCredentials.telegram;
  if (!creds) return;
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${creds.botToken}/getUpdates?offset=${telegramOffset}&limit=50&timeout=0`
    );
    const data = await resp.json();
    if (!data.ok) {
      console.error('[Reachouts/Telegram] API error:', data.description);
      reachoutsData.platformStatus.telegram = { connected: false, error: data.description };
      return;
    }

    const messages = [];
    for (const update of (data.result || [])) {
      telegramOffset = Math.max(telegramOffset, update.update_id + 1);
      const msg = update.message || update.channel_post;
      if (!msg) continue;

      const sender = msg.from || msg.chat;
      const name = sender.first_name ? `${sender.first_name} ${sender.last_name || ''}`.trim() : (sender.title || sender.username || 'Unknown');

      messages.push({
        conversationId: `tg-${msg.chat.id}`,
        senderName: name,
        senderAvatar: null,
        lastMessage: msg.text || msg.caption || '[media]',
        timestamp: new Date(msg.date * 1000).toISOString(),
        unread: true,
        url: msg.chat.username ? `https://t.me/${msg.chat.username}` : null,
      });
    }

    if (messages.length > 0) {
      mergeReachoutsMessages('telegram', messages);
      console.log(`[Reachouts/Telegram] Synced ${messages.length} messages`);
    }
    reachoutsData.platformStatus.telegram = { connected: true, lastSync: new Date().toISOString(), mode: 'bot-api' };
  } catch (e) {
    console.error('[Reachouts/Telegram] Poll error:', e.message);
  }
}

app.post('/api/reachouts/connect/telegram', (req, res) => {
  const { botToken } = req.body;
  if (!botToken) return res.status(400).json({ error: 'botToken required' });
  reachoutsCredentials.telegram = { botToken };
  saveReachoutsCreds(reachoutsCredentials);
  telegramOffset = 0;
  startPolling('telegram', pollTelegram, 30000); // every 30s
  res.json({ ok: true, message: 'Telegram bot connected — polling every 30 seconds' });
});

// ---- TWITTER/X (Internal GraphQL API with session cookies) ----

const TWITTER_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

async function pollTwitter() {
  const creds = reachoutsCredentials.twitter;
  if (!creds) return;
  try {
    // Fetch DM inbox using Twitter's internal API
    const headers = {
      'Authorization': `Bearer ${TWITTER_BEARER}`,
      'x-csrf-token': creds.ct0,
      'Cookie': `auth_token=${creds.authToken}; ct0=${creds.ct0}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    };

    // Try the DM inbox endpoint
    const inboxResp = await fetch(
      'https://x.com/i/api/1.1/dm/inbox_initial_state.json?include_profile_interstitial_type=1&include_blocking=1&include_blocked_by=1&include_followed_by=1&include_want_retweets=1&include_mute_edge=1&include_can_dm=1&include_can_media_tag=1&include_ext_is_blue_verified=1&include_ext_verified_type=1&include_ext_profile_image_shape=1&skip_status=1&dm_secret_conversations_enabled=false&krs_registration_enabled=true&cards_platform=Web-12&include_cards=1&include_ext_alt_text=true&include_ext_limited_action_results=true&include_quote_count=true&include_reply_count=1&tweet_mode=extended&include_ext_views=true&dm_users=true&include_groups=true&include_inbox_timelines=true&include_ext_media_color=true&supports_reactions=true&include_ext_edit_control=true&ext=mediaColor%2CaltText%2CmediaStats%2ChighlightedLabel%2CvoiceInfo%2CbirdwatchPivot%2CsuperFollowMetadata%2CunmentionInfo%2CeditControl',
      { headers }
    );

    if (inboxResp.status === 401 || inboxResp.status === 403) {
      console.error('[Reachouts/Twitter] Session expired — reconnect needed');
      reachoutsData.platformStatus.twitter = { connected: false, error: 'Session expired — update cookies' };
      stopPolling('twitter');
      return;
    }

    const inbox = await inboxResp.json();
    const conversations = inbox.inbox_initial_state?.conversations || {};
    const users = inbox.inbox_initial_state?.users || {};
    const entries = inbox.inbox_initial_state?.entries || [];

    const messages = [];
    for (const [convId, conv] of Object.entries(conversations)) {
      const isUnread = conv.status === 'HAS_MORE' ||
        (conv.last_read_event_id && conv.sort_event_id && conv.last_read_event_id < conv.sort_event_id);

      // Find last message in this conversation from entries
      const convEntries = entries.filter(e => e.message?.conversation_id === convId);
      const lastEntry = convEntries[convEntries.length - 1];
      const lastMsg = lastEntry?.message;

      // Get participant names
      const participantIds = (conv.participants || []).map(p => p.user_id);
      const participantNames = participantIds
        .map(id => users[id]?.name || users[id]?.screen_name || '')
        .filter(Boolean)
        .join(', ');

      const senderId = lastMsg?.message_data?.sender_id;
      const senderName = users[senderId]?.name || participantNames || 'Unknown';

      messages.push({
        conversationId: `tw-${convId}`,
        senderName,
        senderAvatar: users[senderId]?.profile_image_url_https || null,
        lastMessage: lastMsg?.message_data?.text || '',
        timestamp: lastMsg?.message_data?.time
          ? new Date(parseInt(lastMsg.message_data.time)).toISOString()
          : new Date(parseInt(conv.sort_timestamp)).toISOString(),
        unread: !!isUnread,
        url: `https://x.com/messages/${convId}`,
      });
    }

    mergeReachoutsMessages('twitter', messages);
    reachoutsData.platformStatus.twitter = { connected: true, lastSync: new Date().toISOString(), mode: 'session-api' };
    console.log(`[Reachouts/Twitter] Synced ${messages.length} conversations`);
  } catch (e) {
    console.error('[Reachouts/Twitter] Poll error:', e.message);
    reachoutsData.platformStatus.twitter = { connected: true, lastSync: reachoutsData.lastSync.twitter, error: e.message };
  }
}

app.post('/api/reachouts/connect/twitter', (req, res) => {
  const { ct0, authToken } = req.body;
  if (!ct0 || !authToken) return res.status(400).json({ error: 'ct0 and authToken cookies required' });
  reachoutsCredentials.twitter = { ct0, authToken };
  saveReachoutsCreds(reachoutsCredentials);
  startPolling('twitter', pollTwitter, 120000); // every 2 min
  res.json({ ok: true, message: 'Twitter connected via session — polling every 2 minutes. Session lasts ~months.' });
});

// ---- DISCORD (User token API) ----

async function pollDiscord() {
  const creds = reachoutsCredentials.discord;
  if (!creds) return;
  try {
    const headers = {
      'Authorization': creds.userToken,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };

    // Get DM channels
    const channelsResp = await fetch('https://discord.com/api/v9/users/@me/channels', { headers });
    if (channelsResp.status === 401 || channelsResp.status === 403) {
      console.error('[Reachouts/Discord] Token invalid or expired');
      reachoutsData.platformStatus.discord = { connected: false, error: 'Token invalid — update it' };
      stopPolling('discord');
      return;
    }
    const channels = await channelsResp.json();

    // Get read states to determine unread
    let readStates = {};
    try {
      const readResp = await fetch('https://discord.com/api/v9/users/@me/read-states', { headers });
      if (readResp.ok) {
        const readData = await readResp.json();
        readData.forEach(rs => { readStates[rs.id] = rs; });
      }
    } catch (e) { /* read states endpoint may not be available */ }

    const messages = [];
    for (const channel of channels.slice(0, 20)) {
      if (channel.type !== 1 && channel.type !== 3) continue; // 1=DM, 3=group DM

      const recipientNames = (channel.recipients || []).map(r => r.global_name || r.username).join(', ');

      // Fetch last message
      let lastMessage = '';
      let lastTimestamp = channel.last_message_id
        ? new Date(Number(BigInt(channel.last_message_id) >> 22n) + 1420070400000).toISOString()
        : new Date().toISOString();

      try {
        const msgsResp = await fetch(`https://discord.com/api/v9/channels/${channel.id}/messages?limit=1`, { headers });
        if (msgsResp.ok) {
          const msgs = await msgsResp.json();
          if (msgs[0]) {
            lastMessage = msgs[0].content || '[attachment]';
            lastTimestamp = msgs[0].timestamp;
          }
        }
      } catch (e) { /* skip if rate limited */ }

      // Determine if unread
      const readState = readStates[channel.id];
      const isUnread = readState
        ? (channel.last_message_id && channel.last_message_id !== readState.last_message_id)
        : !!channel.last_message_id;

      messages.push({
        conversationId: `discord-${channel.id}`,
        senderName: recipientNames || 'Unknown',
        senderAvatar: channel.recipients?.[0]?.avatar
          ? `https://cdn.discordapp.com/avatars/${channel.recipients[0].id}/${channel.recipients[0].avatar}.png`
          : null,
        lastMessage,
        timestamp: lastTimestamp,
        unread: !!isUnread,
        url: `https://discord.com/channels/@me/${channel.id}`,
      });

      // Rate limit protection
      await new Promise(r => setTimeout(r, 200));
    }

    mergeReachoutsMessages('discord', messages);
    reachoutsData.platformStatus.discord = { connected: true, lastSync: new Date().toISOString(), mode: 'user-token' };
    console.log(`[Reachouts/Discord] Synced ${messages.length} DM channels`);
  } catch (e) {
    console.error('[Reachouts/Discord] Poll error:', e.message);
    reachoutsData.platformStatus.discord = { connected: true, lastSync: reachoutsData.lastSync.discord, error: e.message };
  }
}

app.post('/api/reachouts/connect/discord', (req, res) => {
  const { userToken } = req.body;
  if (!userToken) return res.status(400).json({ error: 'userToken required (from browser dev tools)' });
  reachoutsCredentials.discord = { userToken };
  saveReachoutsCreds(reachoutsCredentials);
  startPolling('discord', pollDiscord, 180000); // every 3 min (conservative to avoid detection)
  res.json({ ok: true, message: 'Discord connected — polling every 3 minutes. WARNING: self-bots risk account ban.' });
});

// ---- LINKEDIN (Voyager API with session cookies) ----

async function pollLinkedin() {
  const creds = reachoutsCredentials.linkedin;
  if (!creds) return;
  try {
    const headers = {
      'Cookie': `li_at=${creds.liAt}; JSESSIONID="${creds.jsessionid}"`,
      'csrf-token': creds.jsessionid,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/vnd.linkedin.normalized+json+2.1',
      'x-li-lang': 'en_US',
      'x-li-track': '{"clientVersion":"1.13.8","mpVersion":"1.13.8","osName":"web","timezoneOffset":-5,"timezone":"America/New_York","deviceFormFactor":"DESKTOP","mpName":"voyager-web"}',
      'x-restli-protocol-version': '2.0.0',
    };

    const convResp = await fetch(
      'https://www.linkedin.com/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&q=syncToken&count=20',
      { headers }
    );

    if (convResp.status === 401 || convResp.status === 403 || convResp.status === 999) {
      console.error('[Reachouts/LinkedIn] Session expired or blocked');
      reachoutsData.platformStatus.linkedin = { connected: false, error: 'Session expired — update cookies' };
      stopPolling('linkedin');
      return;
    }

    const convData = await convResp.json();
    const conversations = convData.elements || convData.included?.filter(e => e.$type === 'com.linkedin.voyager.messaging.Conversation') || [];

    const messages = [];
    for (const conv of conversations.slice(0, 15)) {
      const participants = conv['*participants'] || conv.participants || [];
      let senderName = 'Unknown';

      // Try to extract participant names from included entities
      if (convData.included) {
        const profiles = convData.included.filter(e =>
          e.$type === 'com.linkedin.voyager.identity.shared.MiniProfile' ||
          e.$type === 'com.linkedin.voyager.messaging.MessagingMember'
        );
        const names = profiles
          .filter(p => p.firstName || p.miniProfile)
          .map(p => p.firstName ? `${p.firstName} ${p.lastName || ''}`.trim() : '')
          .filter(Boolean);
        if (names.length > 0) senderName = names[0];
      }

      // Fallback to participantNames if available
      if (senderName === 'Unknown' && conv.participantNames) {
        senderName = conv.participantNames;
      }

      const lastEvent = conv.events?.[0] || {};
      const eventContent = lastEvent.eventContent || {};
      const messageBody = eventContent.attributedBody?.text ||
        eventContent.body ||
        eventContent.subject ||
        '';

      const entityUrn = conv.entityUrn || conv['*elements']?.[0] || '';
      const convId = entityUrn.split(':').pop() || `li-${Date.now()}`;

      messages.push({
        conversationId: `li-${convId}`,
        senderName,
        lastMessage: messageBody,
        timestamp: conv.lastActivityAt ? new Date(conv.lastActivityAt).toISOString() : new Date().toISOString(),
        unread: !!conv.unreadCount || conv.read === false,
        url: `https://www.linkedin.com/messaging/thread/${convId}/`,
      });
    }

    mergeReachoutsMessages('linkedin', messages);
    reachoutsData.platformStatus.linkedin = { connected: true, lastSync: new Date().toISOString(), mode: 'session-api' };
    console.log(`[Reachouts/LinkedIn] Synced ${messages.length} conversations`);
  } catch (e) {
    console.error('[Reachouts/LinkedIn] Poll error:', e.message);
    reachoutsData.platformStatus.linkedin = { connected: true, lastSync: reachoutsData.lastSync.linkedin, error: e.message };
  }
}

app.post('/api/reachouts/connect/linkedin', (req, res) => {
  const { liAt, jsessionid } = req.body;
  if (!liAt || !jsessionid) return res.status(400).json({ error: 'liAt and jsessionid cookies required' });
  reachoutsCredentials.linkedin = { liAt, jsessionid };
  saveReachoutsCreds(reachoutsCredentials);
  startPolling('linkedin', pollLinkedin, 300000); // every 5 min (conservative — LinkedIn is aggressive)
  res.json({ ok: true, message: 'LinkedIn connected — polling every 5 minutes. Sessions expire in ~1-2 weeks.' });
});

// ---- CONNECT / DISCONNECT / STATUS ----

app.post('/api/reachouts/disconnect/:platform', (req, res) => {
  const { platform } = req.params;
  stopPolling(platform);
  reachoutsCredentials[platform] = null;
  saveReachoutsCreds(reachoutsCredentials);
  reachoutsData.platformStatus[platform] = { connected: false };
  saveReachoutsData(reachoutsData);
  res.json({ ok: true, message: `${platform} disconnected` });
});

app.get('/api/reachouts/credentials', (req, res) => {
  const status = {};
  for (const [platform, creds] of Object.entries(reachoutsCredentials)) {
    status[platform] = {
      connected: !!creds,
      polling: !!pollingIntervals[platform],
      mode: reachoutsData.platformStatus[platform]?.mode || null,
    };
  }
  res.json(status);
});

// ---- EXTENSION SYNC (still supported alongside server polling) ----

app.post('/api/reachouts/sync', (req, res) => {
  const { platform, messages, extensionId } = req.body;
  if (!platform || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'platform and messages[] required' });
  }
  const validPlatforms = ['twitter', 'discord', 'linkedin', 'gmail', 'telegram', 'other'];
  if (!validPlatforms.includes(platform)) {
    return res.status(400).json({ error: `Invalid platform. Use: ${validPlatforms.join(', ')}` });
  }

  const formatted = messages.map(msg => ({
    conversationId: msg.conversationId || msg.senderId || `${platform}-${Date.now()}`,
    senderName: msg.senderName || 'Unknown',
    senderAvatar: msg.senderAvatar || null,
    lastMessage: msg.lastMessage || msg.preview || '',
    timestamp: msg.timestamp || new Date().toISOString(),
    unread: msg.unread !== undefined ? msg.unread : true,
    url: msg.url || null,
  }));

  mergeReachoutsMessages(platform, formatted);
  reachoutsData.platformStatus[platform] = {
    ...reachoutsData.platformStatus[platform],
    connected: true,
    lastSync: reachoutsData.lastSync[platform],
    extensionId,
  };

  res.json({ ok: true, totalMessages: reachoutsData.messages.filter(m => m.platform === platform).length });
});

// ---- READ ENDPOINTS ----

app.get('/api/reachouts/messages', (req, res) => {
  const { platform, unreadOnly } = req.query;
  let msgs = reachoutsData.messages;
  if (platform) msgs = msgs.filter(m => m.platform === platform);
  if (unreadOnly === 'true') msgs = msgs.filter(m => m.unread && !m.markedRead);
  msgs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json({ messages: msgs, lastSync: reachoutsData.lastSync });
});

app.get('/api/reachouts/summary', (req, res) => {
  const platforms = ['twitter', 'discord', 'linkedin', 'gmail', 'telegram', 'other'];
  const summary = {};
  platforms.forEach(p => {
    const msgs = reachoutsData.messages.filter(m => m.platform === p);
    summary[p] = {
      total: msgs.length,
      unread: msgs.filter(m => m.unread && !m.markedRead).length,
      lastSync: reachoutsData.lastSync[p] || null,
      connected: !!(reachoutsData.platformStatus[p]?.connected),
      mode: reachoutsData.platformStatus[p]?.mode || null,
      error: reachoutsData.platformStatus[p]?.error || null,
    };
  });
  res.json({ summary, totalUnread: Object.values(summary).reduce((s, p) => s + p.unread, 0) });
});

app.post('/api/reachouts/mark-read', (req, res) => {
  const { conversationIds, platform, markAll } = req.body;
  if (markAll && platform) {
    reachoutsData.messages.forEach(m => { if (m.platform === platform) m.markedRead = true; });
  } else if (Array.isArray(conversationIds)) {
    reachoutsData.messages.forEach(m => { if (conversationIds.includes(m.conversationId)) m.markedRead = true; });
  }
  saveReachoutsData(reachoutsData);
  res.json({ ok: true });
});

app.post('/api/reachouts/manual', (req, res) => {
  const { platform, senderName, lastMessage, url } = req.body;
  if (!senderName) return res.status(400).json({ error: 'senderName required' });
  reachoutsData.messages.push({
    platform: platform || 'other',
    conversationId: `manual-${Date.now()}`,
    senderName,
    senderAvatar: null,
    lastMessage: lastMessage || '',
    timestamp: new Date().toISOString(),
    unread: true,
    url: url || null,
    markedRead: false,
  });
  saveReachoutsData(reachoutsData);
  res.json({ ok: true });
});

app.get('/api/reachouts/status', (req, res) => {
  res.json({ platforms: reachoutsData.platformStatus, lastSync: reachoutsData.lastSync });
});

app.listen(PORT, () => {
  console.log(`Pigeon Finder API running on port ${PORT}`);

  // Warm backburn index — non-blocking, retries on failure
  refreshBackburnIndex().catch(e => console.error('[Backburn] initial refresh failed:', e.message));

  // Auto-reconnect saved credentials on startup
  if (reachoutsCredentials.gmail) {
    console.log('[Reachouts] Auto-reconnecting Gmail...');
    startPolling('gmail', pollGmail, 120000);
  }
  if (reachoutsCredentials.telegram) {
    console.log('[Reachouts] Auto-reconnecting Telegram...');
    startPolling('telegram', pollTelegram, 30000);
  }
  if (reachoutsCredentials.twitter) {
    console.log('[Reachouts] Auto-reconnecting Twitter...');
    startPolling('twitter', pollTwitter, 120000);
  }
  if (reachoutsCredentials.discord) {
    console.log('[Reachouts] Auto-reconnecting Discord...');
    startPolling('discord', pollDiscord, 180000);
  }
  if (reachoutsCredentials.linkedin) {
    console.log('[Reachouts] Auto-reconnecting LinkedIn...');
    startPolling('linkedin', pollLinkedin, 300000);
  }
});

// --- Helpers ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCompany(c, num) {
  const lines = [];
  lines.push(`${num}. **${s(c.name || c.company_name || c.display_name || '?')}**`);

  const desc = s(c.description || c.short_description || c.tagline);
  if (desc) lines.push(`   Desc: ${desc.slice(0, 300)}`);

  // Website
  if (c.website?.url) lines.push(`   Web: ${c.website.url}`);
  else if (c.website?.domain) lines.push(`   Web: ${c.website.domain}`);
  else {
    const web = s(c.website || c.homepage_url || c.domain || c.url);
    if (web && typeof web === 'string') lines.push(`   Web: ${web}`);
  }

  // Socials
  if (c.socials) {
    if (c.socials.linkedin?.url || c.socials.linkedin) lines.push(`   LinkedIn: ${s(c.socials.linkedin?.url || c.socials.linkedin)}`);
    if (c.socials.twitter?.url || c.socials.twitter) lines.push(`   Twitter: ${s(c.socials.twitter?.url || c.socials.twitter)}`);
    if (c.socials.github?.url || c.socials.github) lines.push(`   GitHub: ${s(c.socials.github?.url || c.socials.github)}`);
    if (c.socials.crunchbase?.url || c.socials.crunchbase) lines.push(`   Crunchbase: ${s(c.socials.crunchbase?.url || c.socials.crunchbase)}`);
  }

  // Contact
  if (c.contact) {
    if (c.contact.emails?.length) lines.push(`   Email: ${c.contact.emails.slice(0, 2).join(', ')}`);
    if (c.contact.phone_numbers?.length) lines.push(`   Phone: ${c.contact.phone_numbers[0]}`);
  }

  // Funding
  if (c.funding) {
    const f = c.funding;
    // funding_total is snake_case in the API
    const total = f.funding_total || f.fundingTotal;
    if (total) lines.push(`   Total Raised: ${money(total)}`);
    
    // Stage - try all variants
    const stage = f.last_funding_type || f.lastFundingType || f.funding_stage || f.stage;
    if (stage && typeof stage === 'string') lines.push(`   Stage: ${stage}`);
    
    // Date
    const fdate = f.last_funding_at || f.last_funding_date || f.lastFundingDate;
    if (fdate) lines.push(`   Last Funding Date: ${String(fdate).slice(0, 10)}`);
    
    // Last round amount
    if (f.last_funding_total) lines.push(`   Last Round Amount: ${money(f.last_funding_total)}`);
    
    // Num rounds
    if (f.num_funding_rounds) lines.push(`   Rounds: ${f.num_funding_rounds}`);
    
    // Top-level investors array
    if (Array.isArray(f.investors) && f.investors.length > 0) {
      const investorNames = f.investors.map((i) => i.name).filter(Boolean).slice(0, 8);
      if (investorNames.length) lines.push(`   Investors: ${investorNames.join(', ')}`);
    }
    
    // Also try fundingRounds if they exist (GraphQL style)
    if (Array.isArray(f.fundingRounds || f.funding_rounds)) {
      const rounds = (f.fundingRounds || f.funding_rounds).map((r) => {
        const amt = money(r.fundingAmount || r.funding_amount || r.amount);
        const type = r.fundingRoundType || r.funding_round_type || r.type || '';
        const date = (r.announcedDate || r.announced_date || '') ? ` (${String(r.announcedDate || r.announced_date).slice(0, 10)})` : '';
        const investors = (r.investors || []).map((i) => {
          const name = i.investorName || i.investor_name || i.name || '';
          return (i.isLead || i.is_lead) ? `${name} [lead]` : name;
        }).filter(Boolean);
        return `${type}${amt ? ' ' + amt : ''}${date}${investors.length ? ' — ' + investors.join(', ') : ''}`;
      }).filter(Boolean);
      if (rounds.length) lines.push(`   Round Details: ${rounds.join(' → ')}`);
    }
  }

  const val = money(c.valuation || c.post_money_valuation);
  if (val) lines.push(`   Valuation: ${val}`);

  // Team
  const team = c.headcount || c.employee_count || c.num_employees || c.team_size;
  if (team) lines.push(`   Team Size: ${team}`);

  // Founders
  if (Array.isArray(c.founders)) {
    const founderInfo = c.founders.map((f) => {
      const name = s(f.name || f.full_name || f);
      const title = f.title ? ` (${f.title})` : '';
      const linkedin = f.linkedin_url || f.socials?.linkedin || '';
      return `${name}${title}${linkedin ? ' ' + linkedin : ''}`;
    }).filter(Boolean);
    if (founderInfo.length) lines.push(`   Founders: ${founderInfo.join('; ')}`);
  }

  // Tags
  if (Array.isArray(c.tagsV2)) {
    const tagNames = c.tagsV2.map((t) => t.displayValue || t.display_value || t.name || '').filter(Boolean);
    if (tagNames.length) lines.push(`   Tags: ${tagNames.join(', ')}`);
  } else {
    const tags = tagStr(c.tags || c.industries || c.verticals || c.sectors);
    if (tags) lines.push(`   Tags: ${tags}`);
  }

  // Location
  if (c.location) {
    if (typeof c.location === 'object') {
      const loc = [c.location.city, c.location.state, c.location.country].filter(Boolean).join(', ');
      if (loc) lines.push(`   HQ: ${loc}`);
    } else {
      lines.push(`   HQ: ${s(c.location)}`);
    }
  }

  // Founded
  if (c.founding_date) lines.push(`   Founded: ${String(c.founding_date).slice(0, 10)}`);
  else {
    const yr = c.founded_year || c.year_founded;
    if (yr) lines.push(`   Founded: ${yr}`);
  }

  // Highlights
  if (Array.isArray(c.highlights)) {
    const hl = c.highlights.map((h) => h.text || h).filter(Boolean).slice(0, 3);
    if (hl.length) lines.push(`   Highlights: ${hl.join(' | ')}`);
  }

  // Traction metrics
  if (c.webTraffic) lines.push(`   Web Traffic: ${s(c.webTraffic)}`);
  if (c.tractionMetrics) {
    const tm = c.tractionMetrics;
    if (tm.webTraffic?.ago30d?.percentChange)
      lines.push(`   Traffic Growth (30d): ${tm.webTraffic.ago30d.percentChange}%`);
    if (tm.headcount?.ago90d?.percentChange)
      lines.push(`   Headcount Growth (90d): ${tm.headcount.ago90d.percentChange}%`);
    if (tm.headcountEngineering?.ago90d?.percentChange)
      lines.push(`   Eng Growth (90d): ${tm.headcountEngineering.ago90d.percentChange}%`);
  }

  // Revenue
  const rev = money(c.revenue || c.estimated_revenue || c.arr);
  if (rev) lines.push(`   Revenue: ${rev}`);
  if (c.revenue_range) lines.push(`   Rev Range: ${s(c.revenue_range)}`);

  // Ownership
  if (c.ownership_status) lines.push(`   Status: ${c.ownership_status}`);
  if (c.customer_type) lines.push(`   Customer Type: ${c.customer_type}`);

  const id = c.id || c.entity_id || c.urn;
  if (id) lines.push(`   ID: ${id}`);

  return lines.join('\n');
}

function s(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number') return String(val);
  if (typeof val === 'object') {
    if (val.value !== undefined) return s(val.value);
    if (val.url) return s(val.url);
    if (val.name) return s(val.name);
    if (val.display_name) return s(val.display_name);
    if (val.label) return s(val.label);
    if (Array.isArray(val)) return val.map(s).filter(Boolean).join(', ');
    try { const j = JSON.stringify(val); if (j.length < 150) return j; } catch {}
    return '';
  }
  return String(val);
}

function money(val) {
  if (!val) return '';
  let n = val;
  if (typeof val === 'object') {
    n = val.value || val.amount || val.usd || null;
    if (!n) return s(val);
  }
  if (typeof n === 'string') {
    if (/[$MBK]/.test(n)) return n;
    n = parseFloat(n.replace(/[^0-9.]/g, ''));
  }
  if (typeof n !== 'number' || isNaN(n)) return s(val);
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

function tagStr(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    return val.map((t) => typeof t === 'string' ? t : (t?.name || t?.label || t?.value || '')).filter(Boolean).join(', ');
  }
  return s(val);
}

function extractSearchTerms(message) {
  const topicWords = new Set([
    'gambling', 'betting', 'casino', 'sports', 'parlay', 'parlays', 'sportsbook',
    'trading', 'crypto', 'blockchain', 'defi', 'web3', 'token', 'tokens', 'dao', 'daos',
    'fintech', 'finance', 'banking', 'payment', 'payments', 'neobank',
    'climate', 'cleantech', 'energy', 'solar', 'carbon',
    'consumer', 'social', 'gaming', 'esports', 'gamification',
    'ai', 'artificial', 'intelligence', 'ml', 'machine', 'learning',
    'health', 'healthcare', 'biotech', 'pharma',
    'saas', 'enterprise', 'b2b', 'marketplace', 'ecommerce',
    'messaging', 'chat', 'mobile',
    'hedge', 'fund', 'prediction', 'market', 'options',
    'nft', 'metaverse', 'virtual', 'reality',
    'insurance', 'insurtech', 'proptech', 'real', 'estate',
    'security', 'cybersecurity', 'privacy',
    'education', 'edtech', 'legal', 'legaltech',
    'food', 'delivery', 'logistics', 'supply', 'chain',
    'robotics', 'automation', 'drone', 'space',
  ]);

  const msg = message.toLowerCase().replace(/[^\w\s-]/g, ' ');
  const words = msg.split(/\s+/).filter((w) => w.length > 1);

  const topics = words.filter((w) => topicWords.has(w));

  const phrases = [];
  if (/sports?\s*betting/i.test(message)) phrases.push('sports betting');
  if (/social\s*(trading|gambling|betting)/i.test(message)) phrases.push('social ' + message.match(/social\s*(trading|gambling|betting)/i)[1].toLowerCase());
  if (/prediction\s*market/i.test(message)) phrases.push('prediction market');
  if (/hedge\s*fund/i.test(message)) phrases.push('hedge fund');
  if (/daily\s*fantasy/i.test(message)) phrases.push('daily fantasy');

  const seen = new Set();
  const parts = [];

  for (const p of phrases) {
    parts.push(p);
    p.split(/\s+/).forEach((w) => seen.add(w));
  }

  for (const t of topics) {
    if (!seen.has(t)) {
      parts.push(t);
      seen.add(t);
    }
  }

  let query = parts.join(' ').trim();

  if (query.length < 3) {
    query = words
      .filter((w) => w.length > 4)
      .slice(0, 5)
      .join(' ');
  }

  // Keep it focused but don't over-truncate — Railway has no timeout
  const finalWords = query.split(/\s+/).slice(0, 8);
  return finalWords.join(' ').slice(0, 80);
}

// Apply form submissions — stores in Airtable under "Website Applications" stage
app.post('/api/apply', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { company_name, website, description, telegram, email, additional_info, pitch_deck_link } = req.body;
  if (!company_name || !email) return res.status(400).json({ error: 'company_name and email required' });

  const timestamp = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) + ' EST';
  console.log(`[Apply] New application: ${company_name} (${email}) at ${timestamp}`);

  // Store in a local JSON file (backup)
  const APPLY_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'applications.json');
  let apps = [];
  try { if (fs.existsSync(APPLY_FILE)) apps = JSON.parse(fs.readFileSync(APPLY_FILE, 'utf8')); } catch(e) {}
  apps.push({ company_name, website, description, telegram, email, additional_info, pitch_deck_link, submitted_at: new Date().toISOString() });
  try { fs.writeFileSync(APPLY_FILE, JSON.stringify(apps, null, 2)); } catch(e) {}

  // Add to Airtable as "Website Applications" stage
  const headers = airtableHeaders();
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (headers && baseId) {
    try {
      const tableName = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'All Companies');

      // Build notes with all application details
      const noteLines = [
        '[Website Application · ' + timestamp + ']',
        'Description: ' + (description || 'N/A'),
        'Pitch Deck: ' + (pitch_deck_link || 'N/A'),
        'Telegram: ' + (telegram || 'N/A'),
        'Email: ' + email,
        additional_info ? 'Additional: ' + additional_info : ''
      ].filter(Boolean).join('\n');

      const fields = {
        'Company': company_name,
        'CRM Stage': 'Website Applications',
        'Source': 'Website Apply Form',
        'Company Link': website || '',
        'Original Notes + Ongoing Negotiation Notes': noteLines,
      };

      // Map form fields to Airtable columns
      // Email stored in Initial Reachout Notes for easy access
      if (email) fields['Initial Reachout Notes'] = 'Email: ' + email + (telegram ? '\nTelegram: ' + telegram : '');
      // Description goes into Intro Call Notes
      if (description) fields['Intro Call Notes'] = description;

      const createRes = await fetch(AIRTABLE_API + '/' + baseId + '/' + tableName, {
        method: 'POST', headers,
        body: JSON.stringify({ fields })
      });

      if (createRes.ok) {
        const record = await createRes.json();
        console.log('[Apply] Added ' + company_name + ' to Airtable as Website Application, id:', record.id);
        return res.json({ success: true, message: 'Application received', airtable: 'created', stage: 'Website Applications' });
      } else {
        const err = await createRes.text();
        console.error('[Apply] Airtable create error:', createRes.status, err.slice(0, 500));
        // If "Website Applications" stage doesn't exist, try with "Warm" as fallback
        const fallbackFields = { ...fields, 'CRM Stage': 'Warm' };
        const fallbackRes = await fetch(AIRTABLE_API + '/' + baseId + '/' + tableName, {
          method: 'POST', headers,
          body: JSON.stringify({ fields: fallbackFields })
        });
        if (fallbackRes.ok) {
          console.log('[Apply] Fallback: added as Warm');
          return res.json({ success: true, message: 'Application received', airtable: 'fallback_warm', error_detail: err.slice(0, 300) });
        } else {
          const err2 = await fallbackRes.text();
          console.error('[Apply] Fallback also failed:', err2.slice(0, 300));
          return res.json({ success: true, message: 'Application saved locally but Airtable failed', airtable: 'failed', error_detail: err.slice(0, 300) });
        }
      }
    } catch(e) {
      console.error('[Apply] Airtable error:', e.message);
      return res.json({ success: true, message: 'Application saved locally but Airtable errored', airtable: 'error', error_detail: e.message });
    }
  }

  res.json({ success: true, message: 'Application received (no Airtable config)' });
});

// Get all applications
app.get('/api/applications', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const APPLY_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'applications.json');
  try {
    const apps = JSON.parse(fs.readFileSync(APPLY_FILE, 'utf8'));
    res.json({ applications: apps });
  } catch(e) {
    res.json({ applications: [] });
  }
});
