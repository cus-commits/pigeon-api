const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

const HARMONIC_BASE = 'https://api.harmonic.ai';
const HARMONIC_GQL = 'https://api.harmonic.ai/graphql';

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
  allowedHeaders: ['Content-Type', 'x-harmonic-key', 'x-anthropic-key'],
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
          model: 'claude-sonnet-4-20250514',
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
const fs = require('fs');
const path = require('path');
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

    // Check if results are already full company objects (have name field)
    const alreadyFull = rawResults[0] && typeof rawResults[0] === 'object' && rawResults[0].name;
    if (alreadyFull) {
      console.log(`[Similar] Results already enriched, mapping ${rawResults.length} directly`);
      const companies = rawResults.map(c => gqlToCard(c));
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

    // Enrich via GraphQL
    const enriched = await gqlEnrichCompanies(ids, harmonicKey);
    const companies = enriched.map(c => gqlToCard(c));
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

    // Check if already full objects
    const alreadyFull = rawResults[0] && typeof rawResults[0] === 'object' && rawResults[0].name;
    if (alreadyFull) {
      const companies = rawResults.map(c => gqlToCard(c));
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

    // Step 3: Enrich via GraphQL
    const enriched = await gqlEnrichCompanies(ids, harmonicKey);
    const companies = enriched.map(c => gqlToCard(c));
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
app.post('/api/vetting/backburn', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { companyName, personId } = req.body;
  if (!companyName) return res.status(400).json({ error: 'companyName required' });

  const data = loadVetting();
  const company = data.companies.find(c => (c.name || '').toLowerCase() === companyName.toLowerCase());
  if (!company) return res.status(404).json({ error: 'Company not found' });

  company.dismissed = true;
  company.backburned = true;
  company.backburnedAt = Date.now();
  company.backburnedBy = personId || 'unknown';
  saveVetting(data);
  console.log(`[Vetting] "${companyName}" backburned by ${personId || 'unknown'}`);
  res.json({ success: true });
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
  // Auto-clear stale "scanning" statuses older than 30 min
  const now = Date.now();
  for (const [pid, s] of Object.entries(global._scanStatus || {})) {
    if (s.status === 'scanning' && s.startedAt && (now - s.startedAt) > 10 * 60 * 1000) {
      console.log(`[AutoScan] Clearing stale scanning status for ${pid} (started ${Math.round((now - s.startedAt)/60000)}min ago)`);
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

app.post('/api/autoscan', async (req, res) => {
  // Use SSE-style streaming to keep connection alive through Railway's proxy
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // CRITICAL: sends headers immediately to establish CORS

  // Helper to send keepalive pings
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 5000);

  // Track active scan status in memory (survives tab close)
  if (!global._scanStatus) global._scanStatus = {};

  // These will be set inside try block
  let _personId = null;
  let _profile = null;

  const sendResult = (data) => {
    clearInterval(keepAlive);
    // Save result server-side so it persists even if client disconnects
    if (_personId) {
      try {
        const resultsFile = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'last_scan_results.json');
        let allResults = {};
        try { allResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8')); } catch (e) {}
        allResults[_personId] = {
          ...data,
          results: (data.results || []).slice(0, 100),
          timestamp: Date.now(),
          profileName: _profile?.name || 'Scan',
        };
        fs.writeFileSync(resultsFile, JSON.stringify(allResults));
      } catch (e) { console.error('[ScanResults] Save error:', e.message); }
      global._scanStatus[_personId] = { status: 'done', finishedAt: Date.now(), profileName: _profile?.name || 'Scan' };
    }
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.end();
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

  let companyIds = [];
  let allUrns = new Set();
  let queries = [];
  let categoryMap = {}; // company ID → source category (for savedSearch mode)
  let savedSearchMeta = null; // metadata about saved search scan

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
      res.write(`: Tier ${profile.scanTier}: screening ${prescreenCap} of ${rawCards.length} companies (${rawCards.length - prescreenCap} skipped)\n\n`);
    }
    
    console.log(`[AutoScan] PRE-ENRICH SONNET: Screening ${prescreenCards.length} raw companies...`);
    res.write(`: Screening ${prescreenCards.length} companies with Sonnet (before enrichment)...\n\n`);
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
        res.write(`: Sonnet pre-screen batch ${si + 1}/${Math.ceil(prescreenCards.length / SONNET_PRESCREEN_BATCH)} — ${prescreenPassIds.size} passed so far\n\n`);
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
            if (compName.length > 2) res.write(`: ${isPASS ? '✅' : '❌'} ${compName} — ${reason || fun}\n\n`);
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
    res.write(`: Pre-screen done — ${prescreenPassIds.size} of ${prescreenCards.length} survived (${((prescreenPassIds.size / prescreenCards.length) * 100).toFixed(0)}%) — enriching ${companyIds.length} companies...\n\n`);
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
        const searchUrl = `${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(q)}&size=20`;
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
      res.write(`: Enriching ${fullCompanies.length}/${companyIds.length} companies...\n\n`);
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
      res.write(`: 🏦 CUT "${c.name}" — this is a fund, not a startup\n\n`);
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
  res.write(`: Filtering ${preFiltered.length} enriched companies (removed ${fullCompanies.length - preFiltered.length})...\n\n`);

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
      res.write(`: Sonnet screening batch ${si + 1}/${sonnetBatches} — ${sonnetPassNames.size} passed so far\n\n`);
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
            res.write(`: ${isPASS ? '✅' : '❌'} ${compName} — ${reason || fun}\n\n`);
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
  res.write(`: Sonnet complete — ${opusCandidates.length} passed (${((opusCandidates.length / companyCards.length) * 100).toFixed(0)}%) — ${tierCfg.useOpus ? 'starting Opus...' : 'Sonnet deep scoring...'}\n\n`);
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

  if (opusCandidates.length === 0) {
    console.log('[AutoScan] No companies passed Sonnet filter — skipping deep scoring');
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
      res.write(`: ${modelLabel} deep scoring batch ${batchIdx + 1}/${totalBatches} — ${Object.keys(scoreMap).length} scored\n\n`);
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
      for (const m of batchAnalysis.matchAll(/\*\*([^*]+)\*\*[^]*?Score:\s*(\d+)/gi)) {
        scoreMap[m[1].trim().replace(/🌐/g, '').toLowerCase()] = parseInt(m[2]) || 0;
      }
      for (const m of batchAnalysis.matchAll(/\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*(\d+)\/10\s*\|/gi)) {
        const name = m[1].trim().replace(/\*\*/g, '').replace(/🌐/g, '').replace(/\[.*?\]/g, '').trim().toLowerCase();
        if (name && !scoreMap[name]) scoreMap[name] = parseInt(m[2]) || 0;
      }
      for (const m of batchAnalysis.matchAll(/\*\*([^*]+)\*\*\s*[—\-–]\s*(\d+)\/10/gi)) {
        const name = m[1].trim().replace(/🌐/g, '').toLowerCase();
        if (name && !scoreMap[name]) scoreMap[name] = parseInt(m[2]) || 0;
      }
      for (const m of batchAnalysis.matchAll(/\*?\*?([^*—\n]+?)\*?\*?\s*—\s*PASS/gi)) {
        passSet.add(m[1].trim().toLowerCase());
      }

      console.log(`[AutoScan] Opus batch ${batchIdx + 1} done. Scores: ${Object.keys(scoreMap).length}`);
      
      // Stream top scores and fun verdicts to frontend
      const scoredEntries = Object.entries(scoreMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const scoreEmojis = { 10: '🏆', 9: '💎', 8: '🔥', 7: '⭐', 6: '👍', 5: '🤔', 4: '😬', 3: '👎', 2: '💤', 1: '🗑️' };
      for (const [name, score] of scoredEntries) {
        const emoji = scoreEmojis[Math.min(score, 10)] || '🤔';
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);
        res.write(`: ${emoji} ${displayName} — scored ${score}/10\n\n`);
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

    return sendResult({
      results: companyCards,
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

  const keepAlive = setInterval(() => { res.write(': keepalive\n\n'); }, 5000);
  const sendResult = (data) => { clearInterval(keepAlive); res.write(`data: ${JSON.stringify(data)}\n\n`); res.end(); };

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
                  const searchUrl = `${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(searchTerm + ' crypto')}&size=3`;
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

  const keepAlive = setInterval(() => { res.write(': keepalive\n\n'); }, 5000);
  const sendResult = (data) => { clearInterval(keepAlive); res.write(`data: ${JSON.stringify(data)}\n\n`); res.end(); };

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
                  const searchUrl = `${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(cast.companyName + ' crypto')}&size=3`;
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

  const keepAlive = setInterval(() => { res.write(': keepalive\n\n'); }, 5000);
  const sendResult = (data) => { clearInterval(keepAlive); res.write(`data: ${JSON.stringify(data)}\n\n`); res.end(); };

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
                  const searchUrl = `${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(tw.companyName + ' crypto')}&size=3`;
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
  res.json(status);
});

app.post('/api/signals/super/clear-status', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  global._superSearchStatus = {};
  res.json({ success: true });
});

app.post('/api/signals/super', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const keepAlive = setInterval(() => { res.write(': keepalive\n\n'); }, 5000);
  const scanId = 'super_' + Date.now();
  const sendProgress = (msg, stage, meta) => { 
    res.write(`data: ${JSON.stringify({ progress: msg, stage: stage || null, meta: meta || null })}\n\n`);
    // Also update global status for reconnection
    if (!global._superSearchStatus) global._superSearchStatus = {};
    global._superSearchStatus[scanId] = { status: 'scanning', progress: msg, stage: stage || null, startedAt: global._superSearchStatus[scanId]?.startedAt || Date.now() };
  };
  const sendResult = (data) => { 
    clearInterval(keepAlive); 
    res.write(`data: ${JSON.stringify(data)}\n\n`); 
    res.end();
    // Store results in global status for reconnection
    if (!global._superSearchStatus) global._superSearchStatus = {};
    global._superSearchStatus[scanId] = { status: 'done', finishedAt: Date.now(), results: data };
  };
  const startTime = Date.now();
  if (!global._superSearchStatus) global._superSearchStatus = {};
  global._superSearchStatus[scanId] = { status: 'scanning', progress: 'Initializing...', stage: 'import', startedAt: startTime };

  try {
    const _hdrKey = (req.headers['x-anthropic-key'] || '').trim();
    const anthropicKey = (_hdrKey.startsWith('sk-') ? _hdrKey : '') || process.env.ANTHROPIC_API_KEY;
    const harmonicKey = process.env.HARMONIC_API_KEY;
    const neynarKey = process.env.NEYNAR_API_KEY;
    const rapidApiKey = process.env.RAPIDAPI_KEY;

    console.log('[Super] Anthropic key source:', _hdrKey.startsWith('sk-') ? 'header' : 'env', '| key starts:', (anthropicKey || '').slice(0, 8) + '...');

    const {
      sectors = [],
      chains = [],
      sources = ['twitter', 'farcaster', 'github', 'harmonic'],
      minFollowers = 0,
      minEngagement = 0,
      timeRange = 'week',
      stage = [],
      customKeywords = '',
      superTier = 'sonnet', // 'sonnet' | 'opus20' | 'opus80'
    } = req.body;
    const useOpus = superTier === 'opus20' || superTier === 'opus80';
    const opusTopN = superTier === 'opus80' ? 80 : superTier === 'opus20' ? 20 : 0;

    if (sectors.length === 0 && !customKeywords.trim()) {
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

    // ---- HARMONIC ----
    if (sources.includes('harmonic') && harmonicKey) {
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
      for (const kw of hKws) {
        try {
          const searchUrl = `${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(kw + ' crypto startup')}&size=15`;
          console.log('[Super] Harmonic search:', kw);
          const r = await fetch(searchUrl, {
            headers: harmonicHeaders,
          });
          if (r.ok) {
            const data = await r.json();
            const companies = data.results || data.data || data.companies || [];
            console.log('[Super] Harmonic "' + kw + '" returned', companies.length, 'companies');
            for (const c of companies) {
              const desc = c.description || c.short_description || c.tagline || '';
              const funding = c.funding_total || c.total_funding_amount || 0;
              const compStage = c.stage || c.funding_stage || '';

              // Apply stage filter if set
              if (stageFilters.length > 0) {
                const compStageLower = (compStage || '').toLowerCase().replace(/[\s-]/g, '_');
                const noFunding = !funding || funding === 0;
                const matchesStage = stageFilters.some(sf => {
                  if (sf === 'bootstrapped') return noFunding;
                  return compStageLower.includes(sf);
                });
                if (!matchesStage) continue;
              }
              const tm = c.tractionMetrics || {};
              const webGrowth = tm.webTraffic?.ago30d?.percentChange || null;
              const hcGrowth = tm.headcount?.ago90d?.percentChange || null;
              const engGrowth = tm.headcountEngineering?.ago90d?.percentChange || null;
              const highlights = (c.highlights || []).map(h => h.text || h).filter(Boolean).slice(0, 2);
              const founders = Array.isArray(c.founders)
                ? c.founders.map(f => f.name || f.full_name || '').filter(Boolean).join(', ')
                : '';

              allSignals.push({
                source: 'harmonic',
                id: `hm-${c.id || c.entity_id}`,
                title: c.name || c.company_name || c.display_name || '?',
                subtitle: compStage || 'Unknown stage',
                text: desc.slice(0, 300) + (highlights.length ? '\n💡 ' + highlights.join(' | ') : ''),
                url: c.website?.url || c.website?.domain || c.homepage_url || '',
                pfp: c.logo_url || '',
                followers: c.headcount || 0,
                engagement: funding,
                likes: 0,
                timestamp: c.created_at || c.founded_date || null,
                meta: {
                  funding, stage: compStage, headcount: c.headcount,
                  website: c.website?.url || c.homepage_url || '',
                  founders,
                  webGrowth, hcGrowth, engGrowth,
                },
              });
              sourceStats.harmonic++;
            }
          } else {
            const errText = await r.text().catch(() => '');
            console.error('[Super] Harmonic "' + kw + '" failed (' + r.status + '):', errText.slice(0, 200));
          }
          await sleep(200);
        } catch (e) { console.error('[Super] Harmonic search error:', e.message); }
      }
      console.log('[Super] Harmonic:', sourceStats.harmonic, 'signals');
    }

    const totalSignals = allSignals.length;
    console.log('[Super] Total signals:', totalSignals, 'breakdown:', JSON.stringify(sourceStats));

    if (totalSignals === 0) {
      return sendResult({ signals: [], analysis: null, sourceStats, totalSignals: 0, error: 'No signals found. Try broader topics or enable more sources.' });
    }

    // Dedupe by similar text
    sendProgress(`Filtering ${totalSignals} signals — deduplicating...`, 'filter', { total: totalSignals });
    const seen = new Set();
    const deduped = allSignals.filter(s => {
      const key = s.text.slice(0, 80).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Process ALL deduped signals through Sonnet in batches (no cap)
    sendProgress(`${deduped.length} unique signals — sorting by engagement...`, 'filter', { deduped: deduped.length });
    const sorted = [...deduped].sort((a, b) => b.engagement - a.engagement);
    const forClaude = sorted; // Process ALL — no cap
    
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
        const batch = forClaude.slice(batchStart, batchStart + BATCH_SIZE);
        
        sendProgress(`Sonnet batch ${batchIdx + 1}/${totalBatches} — ${Object.keys(allRatings).length} rated, ${totalHigh} HIGH so far`, 'screen', { 
          batch: batchIdx + 1, totalBatches, rated: Object.keys(allRatings).length, high: totalHigh 
        });

        const signalText = batch.map((s, i) =>
          `[${batchStart + i + 1}] SOURCE:${s.source.toUpperCase()} | ${s.title} (${s.subtitle}) | Followers:${s.followers} Engagement:${s.engagement}\n${s.text}`
        ).join('\n\n');

        const prompt = `You are a crypto deal scout for Daxos Capital (Pre-Seed/Seed, $100K-$250K checks).

You're reviewing ${batch.length} signals from MULTIPLE sources: Twitter/X, Farcaster, GitHub repos, Product Hunt, and Harmonic company database.

RATE EACH SIGNAL:
- HIGH: Clearly investable — founder building something specific, raising a round, launching a product, early team with real traction
- MEDIUM: Interesting but needs context — could be a lead worth following  
- LOW: Not relevant — commentary, memes, established projects, noise

BE STRICT. Most should be LOW. Only HIGH if clearly investable.
STEALTH COMPANIES: Always rate LOW unless exceptional repeat founder.

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
            body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
          });

          if (claudeRes.ok) {
            const data = await claudeRes.json();
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
        const topForOpus = rated.filter(s => s.signal === 'HIGH' || s.signal === 'MEDIUM').slice(0, opusTopN);
        if (topForOpus.length > 0) {
          sendProgress(`Deep scoring ${topForOpus.length} signals with Opus...`, 'deepscore', { total: topForOpus.length });
          const opusPrompt = `You are a crypto/tech deal scout for Daxos Capital (Pre-Seed/Seed, $100K-$250K checks).

Score each company/signal 1-10 based on investability. Consider: founder quality, product traction, market timing, uniqueness, funding stage fit.

SCORING GUIDE:
- 9-10: Exceptional — clear product, strong founder, right timing, must-meet
- 7-8: Strong — good signal, worth a call
- 5-6: Interesting but unclear — needs more research
- 1-4: Not investable — noise, too early, wrong fit

STEALTH COMPANIES: Apply -90% score penalty. Only score above 5 if exceptional repeat founder.

Respond with a JSON block then brief analysis per company:
${'`'.repeat(3)}json
{"CompanyName": {"score": 8, "reason": "brief reason"}, ...}
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
      const sonnetCost = forClaude.length * 0.001;
      const opusCost = useOpus ? Math.min(opusTopN, rated.filter(s => s._opusScore).length) * 0.015 : 0;
      const estimatedCost = (sonnetCost + opusCost).toFixed(3);
      return sendResult({ signals: rated, analysis: cleanAnalysis, sourceStats, totalSignals, ddPushed: highSignals.slice(0, maxPush).length, elapsed, estimatedCost, tier: superTier });
    }

    // Fallback: no Claude
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    return sendResult({ signals: sorted.slice(0, 80), analysis: null, sourceStats, totalSignals, elapsed, estimatedCost: '0.00' });

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

    const enriched = await gqlEnrichCompanies(companyIds, harmonicKey);
    const companies = enriched.map(c => gqlToCard(c));

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

  const keepAlive = setInterval(() => { res.write(': keepalive\n\n'); }, 5000);
  const sendResult = (data) => { clearInterval(keepAlive); res.write(`data: ${JSON.stringify(data)}\n\n`); res.end(); };

  const harmonicKey = req.headers['x-harmonic-key'] || process.env.HARMONIC_API_KEY;
  const anthropicKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;
  if (!harmonicKey) return sendResult({ error: 'Harmonic key required' });

  const { query, keywords, antiKeywords, size, saveName } = req.body;
  if (!query) return sendResult({ error: 'query required' });

  try {
    const maxSize = Math.min(parseInt(size) || 30, 100);
    console.log(`[EnhSearch] Query: "${query.slice(0, 60)}" size=${maxSize}`);

    // Run enhanced search
    const results = await enhancedSearch(query, harmonicKey, {
      size: maxSize,
      keywords: keywords || null,
      antiKeywords: antiKeywords || null,
    });

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
    // Sort by most recent first
    url += '&sort%5B0%5D%5Bfield%5D=Company&sort%5B0%5D%5Bdirection%5D=asc';

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
      console.log(`[Airtable] First record fields: ${Object.keys(data.records[0].fields).join(', ')}`);
      console.log(`[Airtable] First record Company field: "${data.records[0].fields['Company']}" | Name: "${data.records[0].fields['Name']}" | company: "${data.records[0].fields['company']}"`);
    }
    const companies = (data.records || []).map(rec => ({
      airtable_id: rec.id,
      created_time: rec.createdTime || null,
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
    }));
    console.log(`[Airtable] Got ${companies.length} companies`);
    res.json({ companies, total: companies.length });
  } catch (e) {
    console.error('[Airtable] Error:', e.message);
    res.json({ error: e.message, companies: [] });
  }
});

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

  // Auto-enrich from Harmonic if we have the key
  if (harmonicKey) {
    try {
      console.log(`[Airtable+Harmonic] Enriching "${company}" before adding...`);
      
      // Try domain lookup first if we have a website
      let harmonicData = null;
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
          const exact = results.find(r => (r.name || '').toLowerCase() === company.toLowerCase());
          const target = exact || results[0];
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
        
        if (!enrichedWebsite) enrichedWebsite = c.website?.url || c.website?.domain || '';
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
    // Check if company already exists
    const checkFormula = encodeURIComponent(`{Company} = "${company.replace(/"/g, '\\"')}"`);
    const checkUrl = `${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${checkFormula}&maxRecords=1`;
    const checkRes = await fetch(checkUrl, { headers });
    if (checkRes.ok) {
      const checkData = await checkRes.json();
      if (checkData.records?.length > 0) {
        const existing = checkData.records[0];
        // Update stage + fill in any missing fields
        const updateFields = { 'CRM Stage': stage || existing.fields['CRM Stage'] };
        if (!existing.fields['Company Link'] && enrichedWebsite) updateFields['Company Link'] = fields['Company Link'];
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

  const { company, stage } = req.body;
  if (!company || !stage) return res.status(400).json({ error: 'company and stage required' });

  try {
    console.log(`[Airtable] Stage change: "${company}" → ${stage}`);
    const formula = encodeURIComponent(`{Company} = "${company.replace(/"/g, '\\"')}"`);
    const r = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${formula}&maxRecords=1`, { headers });
    if (!r.ok) return res.json({ error: `Airtable error: ${r.status}` });
    const data = await r.json();
    let record = data.records?.[0];
    
    // Fallback: SEARCH if exact match fails
    if (!record) {
      console.log(`[Airtable] Stage exact match failed for "${company}", trying SEARCH...`);
      const sf = encodeURIComponent(`SEARCH("${company.replace(/"/g, '\\"')}", {Company})`);
      const sr = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${sf}&maxRecords=5`, { headers });
      if (sr.ok) {
        const sd = await sr.json();
        record = (sd.records || []).find(rec => (rec.fields['Company'] || '').trim() === company);
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
    res.json({ success: true, company, stage });
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

    // Strategy 1: Look up by website domain (most accurate)
    if (website) {
      const domain = website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      if (domain) {
        console.log(`[Enrich] Trying domain lookup: ${domain}`);
        const domainRes = await fetch(`${HARMONIC_BASE}/companies?website_domain=${encodeURIComponent(domain)}`, { headers: { apikey: harmonicKey } });
        if (domainRes.ok) {
          const domainData = await domainRes.json();
          if (domainData.id) {
            targetId = domainData.id;
            console.log(`[Enrich] Found by domain: ${domainData.name} (ID: ${targetId})`);
          }
        }
      }
    }

    // Strategy 2: Typeahead by name
    if (!targetId) {
      console.log(`[Enrich] Trying typeahead: ${company}`);
      const lookupRes = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(company)}&size=3`, { headers: { apikey: harmonicKey } });
      if (lookupRes.ok) {
        const lookupData = await lookupRes.json();
        const results = lookupData.results || [];
        if (results.length > 0) {
          // Try to find exact name match first
          const exact = results.find(r => (r.name || '').toLowerCase() === company.toLowerCase());
          const target = exact || results[0];
          targetId = target.id || (target.entity_urn || '').split(':').pop();
          console.log(`[Enrich] Found by typeahead: ${target.name} (ID: ${targetId})`);
        }
      }
    }

    if (!targetId) return res.json({ error: `"${company}" not found in Harmonic` });

    // Cache the mapping for future batch-funding lookups
    try {
      const HARMONIC_CACHE_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'harmonic_id_cache.json');
      let idCache = {};
      try { if (fs.existsSync(HARMONIC_CACHE_FILE)) idCache = JSON.parse(fs.readFileSync(HARMONIC_CACHE_FILE, 'utf8')); } catch (e) {}
      idCache[company.toLowerCase().trim()] = parseInt(targetId) || targetId;
      try { fs.writeFileSync(HARMONIC_CACHE_FILE, JSON.stringify(idCache)); } catch (e) {}
      console.log(`[Enrich] Cached "${company}" → ID ${targetId}`);
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
    const websiteMatch = harmonicDomain && airtableDomain && (harmonicDomain === airtableDomain || harmonicDomain.includes(airtableDomain) || airtableDomain.includes(harmonicDomain));
    
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

  const { voter, vote } = req.body;
  const company = (req.body.company || '').trim();
  if (!company || !voter || !vote) return res.status(400).json({ error: 'company, voter, and vote required' });

  try {
    // Find the record — use FIND for exact match
    console.log(`[Airtable] Vote lookup: "${company}" by ${voter} (${vote})`);
    const formula = encodeURIComponent(`{Company} = "${company.replace(/"/g, '\\"')}"`);
    const findRes = await fetch(`${AIRTABLE_API}/${baseId}/${AIRTABLE_TABLE}?filterByFormula=${formula}&maxRecords=1`, { headers });
    if (!findRes.ok) {
      console.error(`[Airtable] Vote lookup failed: ${findRes.status}`);
      return res.json({ error: 'Airtable lookup failed' });
    }
    const findData = await findRes.json();
    let record = findData.records?.[0];
    
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

  // Phase 1: Find Harmonic IDs — check cache first, then API lookups
  const idMap = {};
  const needsLookup = [];

  for (const co of batch) {
    const name = co.name || '';
    if (!name) continue;
    const cacheKey = name.toLowerCase().trim();
    if (idCache[cacheKey]) {
      idMap[name] = { harmonicId: idCache[cacheKey], matchMethod: 'cache' };
      console.log(`[BatchFunding] ✓ "${name}" → ID ${idCache[cacheKey]} (cache)`);
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

      // Strategy 1: Domain lookup (highest confidence)
      // Harmonic /companies?website_domain= returns a flat object on match, [] on no match
      if (co.website) {
        const domain = co.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
        if (domain && domain.includes('.')) {
          try {
            // Try exact domain first
            let dr = await fetch(`${HARMONIC_BASE}/companies?website_domain=${encodeURIComponent(domain)}`, { headers: { apikey: harmonicKey } });
            let dd = dr.ok ? await dr.json() : null;
            // If empty array, try with www prefix
            if (dd && ((Array.isArray(dd) && dd.length === 0) || (!dd.id && !dd.entity_urn))) {
              dr = await fetch(`${HARMONIC_BASE}/companies?website_domain=${encodeURIComponent('www.' + domain)}`, { headers: { apikey: harmonicKey } });
              dd = dr.ok ? await dr.json() : null;
            }
            if (dd) {
              const company = Array.isArray(dd) ? dd[0] : (dd.results?.[0] || dd);
              const foundId = company?.id || (company?.entity_urn || company?.entityUrn || '').split(':').pop() || null;
              if (foundId && parseInt(foundId)) { harmonicId = parseInt(foundId); matchMethod = 'domain'; }
            }
          } catch (e) {}
        }
      }

      // Strategy 2: Typeahead search
      // Harmonic typeahead returns: { results: [{ entity_urn, text, type }] }
      // NO `name` or `id` fields — use `text` for matching, parse ID from `entity_urn`
      if (!harmonicId) {
        try {
          const tr = await fetch(`${HARMONIC_BASE}/search/typeahead?query=${encodeURIComponent(name)}&size=5`, { headers: { apikey: harmonicKey } });
          if (tr.ok) {
            const td = await tr.json();
            const raw = (td.results || []).filter(r => r.type === 'COMPANY');
            const coName = name.toLowerCase().trim();
            const coDomain = co.website ? co.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase() : '';

            for (const r of raw) {
              const rid = (r.entity_urn || '').split(':').pop();
              if (!rid || !parseInt(rid)) continue;
              const rText = (r.text || '').toLowerCase().trim();

              if (rText === coName) { harmonicId = parseInt(rid); matchMethod = 'name'; break; }
              if (coDomain && rText.includes(coDomain)) { harmonicId = parseInt(rid); matchMethod = 'domain+typeahead'; break; }
              if (rText.includes(coName) || coName.includes(rText.replace(/\.com|\.io|\.ai|\.xyz|\.co|https?:\/\//g, '').trim())) {
                harmonicId = parseInt(rid); matchMethod = 'name-fuzzy'; break;
              }
            }
            // Fallback: all results point to same company → unanimous match
            if (!harmonicId && raw.length > 0) {
              const urns = new Set(raw.map(r => (r.entity_urn || '').split(':').pop()).filter(Boolean));
              if (urns.size === 1) {
                harmonicId = parseInt([...urns][0]); matchMethod = 'typeahead-unanimous';
              }
            }
          }
        } catch (e) {}
      }

      // Strategy 3: search_agent NL search (catches unusual names)
      if (!harmonicId) {
        try {
          const searchQuery = co.website
            ? `${name} ${co.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]}`
            : name;
          const sr = await fetch(`${HARMONIC_BASE}/search/search_agent?query=${encodeURIComponent(searchQuery)}&size=5`, { headers: { apikey: harmonicKey } });
          if (sr.ok) {
            const sd = await sr.json();
            const results = sd.results || [];
            const coName = name.toLowerCase().trim();
            for (const r of results) {
              const rid = r.id || (r.urn || r.entity_urn || '').split(':').pop();
              if (!rid) continue;
              const rName = (r.name || r.text || '').toLowerCase().trim();
              if (rName === coName || rName.includes(coName) || coName.includes(rName)) {
                harmonicId = parseInt(rid) || rid; matchMethod = 'search-agent'; break;
              }
            }
            if (!harmonicId && results.length >= 1 && name.length < 12) {
              const rid = results[0].id || (results[0].urn || '').split(':').pop();
              if (rid) { harmonicId = parseInt(rid) || rid; matchMethod = 'search-agent-first'; }
            }
          }
        } catch (e) {}
      }

      // Strategy 4: Direct REST lookup by name
      if (!harmonicId) {
        try {
          const nr = await fetch(`${HARMONIC_BASE}/companies?name=${encodeURIComponent(name)}`, { headers: { apikey: harmonicKey } });
          if (nr.ok) {
            const nd = await nr.json();
            const company = Array.isArray(nd) ? nd[0] : (nd.results?.[0] || nd);
            const foundId = company?.id || (company?.entity_urn || company?.entityUrn || '').split(':').pop() || null;
            if (foundId && parseInt(foundId)) {
              harmonicId = parseInt(foundId);
              matchMethod = 'name-direct';
            }
          }
        } catch (e) {}
      }

      if (harmonicId) {
        idMap[name] = { harmonicId, matchMethod };
        // Cache the mapping
        idCache[name.toLowerCase().trim()] = typeof harmonicId === 'number' ? harmonicId : parseInt(harmonicId) || harmonicId;
        console.log(`[BatchFunding] ✓ "${name}" → ID ${harmonicId} (${matchMethod})`);
      } else {
        console.log(`[BatchFunding] ✗ "${name}" — no match (website: ${co.website || 'none'}, twitter: ${co.twitter || 'none'})`);
      }
    } catch (e) {
      console.error(`[BatchFunding] Lookup error for "${name}":`, e.message);
    }
  });

  const CONCURRENCY = 10;
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

  console.log(`[BatchFunding] Enriched ${Object.keys(results).length}/${batch.length} companies`);
  res.json({ results });
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

// Get current cache
app.get('/api/harmonic/cache-id', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const HARMONIC_CACHE_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'harmonic_id_cache.json');
  let idCache = {};
  try { if (fs.existsSync(HARMONIC_CACHE_FILE)) idCache = JSON.parse(fs.readFileSync(HARMONIC_CACHE_FILE, 'utf8')); } catch (e) {}
  res.json({ cache: idCache, count: Object.keys(idCache).length });
});

// Save a note on a company
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

app.listen(PORT, () => {
  console.log(`Pigeon Finder API running on port ${PORT}`);
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
