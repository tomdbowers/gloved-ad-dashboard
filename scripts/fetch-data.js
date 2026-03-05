#!/usr/bin/env node
/**
 * Fetch fresh ad data from Meta Marketing API and update dashboard HTML files
 * Runs daily via GitHub Actions or manually via `node scripts/fetch-data.js`
 *
 * Required env: META_ACCESS_TOKEN
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
if (!ACCESS_TOKEN) {
  console.error('❌ META_ACCESS_TOKEN environment variable is required');
  process.exit(1);
}

const API_VERSION = 'v21.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;
const WINDOWS = {
  '7':  { preset: 'last_7d',  minSpend: 50,  label: 'Last 7 Days' },
  '14': { preset: 'last_14d', minSpend: 100, label: 'Last 14 Days' },
  '30': { preset: 'last_30d', minSpend: 200, label: 'Last 30 Days' },
  '90': { preset: 'last_90d', minSpend: 200, label: 'Last 90 Days' },
  'all': { timeRange: { since: '2020-01-01' }, minSpend: 200, label: 'All Time' },
};

// ─── HTTP helper ────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.error) reject(new Error(json.error.message));
          else resolve(json);
        } catch (e) {
          reject(new Error(`JSON parse failed: ${body.substring(0, 300)}`));
        }
      });
    }).on('error', reject);
  });
}

// ─── Meta API calls ─────────────────────────────────────────
async function getAdAccounts() {
  const url = `${BASE}/me/adaccounts?fields=id,name,currency&access_token=${ACCESS_TOKEN}`;
  const res = await fetchJSON(url);
  return res.data || [];
}

async function getAdInsights(accountId, cfg) {
  const fields = [
    'ad_name', 'campaign_name', 'adset_name',
    'spend', 'impressions', 'clicks', 'inline_link_clicks', 'ctr',
    'actions', 'action_values', 'purchase_roas',
    'video_thruplay_watched_actions',
    'video_avg_time_watched_actions',
    'video_p100_watched_actions'
  ].join(',');

  let all = [];
  let timeParam;
  if (cfg.timeRange) {
    const until = new Date().toISOString().slice(0, 10);
    timeParam = `time_range=${encodeURIComponent(JSON.stringify({ since: cfg.timeRange.since, until }))}`;
  } else {
    timeParam = `date_preset=${cfg.preset}`;
  }
  let url = `${BASE}/${accountId}/insights?level=ad&fields=${fields}&${timeParam}&limit=200&access_token=${ACCESS_TOKEN}`;

  while (url) {
    const res = await fetchJSON(url);
    if (res.data) all = all.concat(res.data);
    url = res.paging && res.paging.next ? res.paging.next : null;
  }
  return all;
}

// ─── Data helpers ───────────────────────────────────────────
function actionVal(actions, type) {
  if (!actions) return 0;
  const hit = actions.find(a => a.action_type === type);
  return hit ? parseFloat(hit.value) : 0;
}

function fmtTime(seconds) {
  if (!seconds) return 'N/A';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── Name cleaning ──────────────────────────────────────────
// Derives a human-friendly creative name from Meta ad_name
// Handles Gloved's naming convention: Buyer|CREATIVE-NAME|URL_variant
function deriveName(adName) {
  let cleaned = adName
    .replace(/\s*[–-]\s*Copy\s*\d*/gi, '')
    .trim();

  const parts = cleaned.split('|').map(p => p.trim()).filter(Boolean);

  // Segments to skip
  const skip = /^(Becks|Joshua_VE|Camilla_SW|Lisa_tal|Jenni_tal|Andrea_tal)$/i;

  const descriptive = parts.filter(p => {
    if (/^URL/i.test(p)) return false;             // URL_LP1.0, URLHP, etc.
    if (/^(LP|HP|LPV)\d/i.test(p)) return false;   // LP1.0, HP, etc.
    if (/^URLP/i.test(p)) return false;
    if (/^TROAS\b/i.test(p) && p.length < 12) return false;
    if (skip.test(p)) return false;
    return true;
  });

  if (descriptive.length === 0) return adName;

  let name = descriptive.join(' ')
    .replace(/^WL_/i, '')
    .replace(/^GLOVED[-_]/i, 'Gloved ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s*0*\d{2,3}$/, '')     // trailing version numbers like 001, 007
    .replace(/\s+/g, ' ')
    .trim();

  // Title-case each word
  name = name.replace(/\b\w+/g, w =>
    w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()
  );

  // Fix known abbreviations
  name = name
    .replace(/\bAi\b/g, 'AI')
    .replace(/\bUgc\b/g, 'UGC')
    .replace(/\bLp\b/g, 'LP')
    .replace(/\bHp\b/g, 'HP')
    .replace(/\bV(\d)/gi, 'V$1')
    .replace(/\bAsc\b/g, 'ASC');

  return name;
}

// ─── Tag derivation ─────────────────────────────────────────
// Extracts market + strategy from campaign/adset naming convention
function deriveTag(campaignName, adsetName, adName) {
  // Market from adset: "US|Prospecting|TROAS_ASC|Ad Set" → "US"
  const market = (adsetName || '').split('|')[0].trim();

  // Strategy from campaign: "T_ROAS|SHOPIFY_API|V0825" → "TROAS"
  let strategy = (campaignName || '').split('|')[0].trim();
  strategy = strategy.replace(/^T_/i, 'T').replace(/_/g, '');

  let tag = market ? `${market} · ${strategy}` : strategy;

  // Flag static-image ads
  if (/image|post.?it|refill.?set|static/i.test(adName) &&
      !/video/i.test(adName)) {
    tag += ' · IMAGE';
  }

  return tag;
}

// ─── Transform one API row → ADS entry ──────────────────────
function transformRow(row, minSpend) {
  const spend = parseFloat(row.spend || 0);
  if (spend < minSpend) return null;

  const impressions = parseInt(row.impressions || 0);
  const clicks      = parseInt(row.clicks || 0);
  const linkClicks  = parseInt(row.inline_link_clicks || 0) ||
                      actionVal(row.actions, 'link_click');

  const purchases = actionVal(row.actions, 'offsite_conversion.fb_pixel_purchase') ||
                    actionVal(row.actions, 'purchase');

  const purchaseValue = actionVal(row.action_values, 'offsite_conversion.fb_pixel_purchase') ||
                        actionVal(row.action_values, 'purchase');

  const roas = spend > 0 ? Math.round((purchaseValue / spend) * 100) / 100 : 0;
  const ctr  = parseFloat(parseFloat(row.ctr || 0).toFixed(2));

  // Video metrics
  const threeSecViews = actionVal(row.actions, 'video_view');
  const thruPlays     = row.video_thruplay_watched_actions?.[0]
                        ? parseInt(row.video_thruplay_watched_actions[0].value) : 0;
  const avgSec        = row.video_avg_time_watched_actions?.[0]
                        ? parseFloat(row.video_avg_time_watched_actions[0].value) : 0;
  const completions   = row.video_p100_watched_actions?.[0]
                        ? parseInt(row.video_p100_watched_actions[0].value) : 0;

  const isVideo = threeSecViews > 0 || thruPlays > 0;

  return {
    name:          deriveName(row.ad_name),
    fullName:      row.ad_name,
    tag:           deriveTag(row.campaign_name, row.adset_name, row.ad_name),
    spend:         Math.round(spend * 100) / 100,
    impressions,
    clicks,
    linkClicks:    Math.round(linkClicks),
    purchases:     Math.round(purchases),
    purchaseValue: Math.round(purchaseValue * 100) / 100,
    roas,
    ctr,
    threeSecViews: Math.round(threeSecViews),
    thruPlays,
    avgPlayTime:   isVideo ? fmtTime(avgSec) : 'N/A',
    completions,
    isVideo
  };
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  console.log('🔍 Discovering ad accounts…');
  const accounts = await getAdAccounts();
  if (accounts.length === 0) throw new Error('No ad accounts found for this token');

  const adsByWindow = {};

  for (const [key, cfg] of Object.entries(WINDOWS)) {
    console.log(`\n⏱  Fetching ${cfg.label}…`);
    let allAds = [];

    for (const acct of accounts) {
      console.log(`   📊 ${acct.name || acct.id} (${acct.currency || '?'})…`);
      const rows = await getAdInsights(acct.id, cfg);
      console.log(`      → ${rows.length} ad rows`);
      const ads = rows.map(r => transformRow(r, cfg.minSpend)).filter(Boolean);
      allAds = allAds.concat(ads);
    }

    allAds.sort((a, b) => b.spend - a.spend);
    adsByWindow[key] = allAds;
    console.log(`   ✅ ${allAds.length} qualifying ads (spend ≥ £${cfg.minSpend})`);
  }

  // ── Inject data into HTML files ──
  const dataBlock = [
    '// __ADS_DATA_START__',
    '// RAW AD DATA — multi-window (pulled from Meta Ads)',
    `// Auto-generated ${new Date().toISOString().slice(0, 10)}`,
    `const ADS_BY_WINDOW = ${JSON.stringify(adsByWindow, null, 2)};`,
    '// __ADS_DATA_END__'
  ].join('\n');

  const marker = /\/\/ __ADS_DATA_START__[\s\S]*?\/\/ __ADS_DATA_END__/;

  function updateFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    let html = fs.readFileSync(filePath, 'utf-8');
    if (!marker.test(html)) {
      console.warn(`   ⚠️  No data markers in ${path.basename(filePath)} — skipping`);
      return false;
    }
    html = html.replace(marker, dataBlock);
    fs.writeFileSync(filePath, html, 'utf-8');
    return true;
  }

  const indexPath = path.join(__dirname, '..', 'index.html');
  const hookPath  = path.join(__dirname, '..', 'hook-factory.html');

  if (updateFile(indexPath)) console.log('\n📝 index.html updated');
  if (updateFile(hookPath))  console.log('📝 hook-factory.html updated');

  const windows = Object.values(WINDOWS).map(w => w.label).join(' / ');
  console.log(`   Data windows: ${windows}`);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
