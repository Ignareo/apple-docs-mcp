#!/usr/bin/env node
/**
 * Refresh / audit the bundled WWDC catalog against developer.apple.com.
 *
 * Why this script exists
 * ----------------------
 * The bundled snapshot under `data/wwdc/` is frozen (currently 2014–2025,
 * 2026-10-23: WWDC26 sessions are already live on Apple's site but absent
 * locally). Apple exposes the session *catalog* in static HTML on the yearly
 * pages (`https://developer.apple.com/videos/wwdc<year>/`), which is what this
 * script reads.
 *
 * Scope / limitation
 * ------------------
 * Only the catalog (session id, title, duration, category, topics, url) can be
 * refreshed from static HTML. Per-session transcripts and code listings are
 * loaded by the WWDC site through JavaScript/AJAX and are not present in the
 * page HTML (`grep` for the transcript text returns nothing), so this script
 * never fabricates `data/wwdc/videos/*.json` content. New sessions discovered
 * here are reported as "missing data file" and are still listed when
 * `--write-catalog` runs, with `hasTranscript`/`hasCode` set to false until the
 * transcript source is automated separately.
 *
 * Usage
 * -----
 *   node scripts/refresh-wwdc-catalog.mjs                 # audit only (default)
 *   node scripts/refresh-wwdc-catalog.mjs --year 2026     # audit one year
 *   node scripts/refresh-wwdc-catalog.mjs --json /tmp/catalog.json
 *   node scripts/refresh-wwdc-catalog.mjs --write-catalog # rewrite data/wwdc/*
 *   node scripts/refresh-wwdc-catalog.mjs --write-catalog --data-dir /tmp/wwdc-copy  # safe write test
 *
 * `--write-catalog` is intentionally opt-in: the repo keeps the snapshot small
 * and reproducible, and bumping the bundled data is a release decision.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let DATA_DIR = path.join(ROOT, 'data', 'wwdc');
let VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const BASE = 'https://developer.apple.com';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

function parseArgs(argv) {
  const options = { years: [], json: undefined, writeCatalog: false, timeoutMs: 30000, dataDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--year') {
      const value = argv[++i];
      if (!/^\d{4}$/.test(value ?? '')) {
        throw new Error('--year expects a 4-digit year');
      }
      options.years.push(value);
    } else if (arg === '--json') {
      options.json = argv[++i];
      if (!options.json) {
        throw new Error('--json expects a path');
      }
    } else if (arg === '--write-catalog') {
      options.writeCatalog = true;
    } else if (arg === '--data-dir') {
      options.dataDir = argv[++i];
      if (!options.dataDir) {
        throw new Error('--data-dir expects a path');
      }
    } else if (arg === '--timeout') {
      options.timeoutMs = Number(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/refresh-wwdc-catalog.mjs [--year YYYY]... [--json path] [--write-catalog] [--data-dir path] [--timeout ms]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fetchText(url, timeoutMs) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

/** Extract one `vc-card` block per session from a yearly page. */
function parseYearPage(html, year) {
  const sessions = [];
  // Each card is an <a href="/videos/play/wwdcYYYY/<id>/" ...> ... </a> block.
  const cardRe = new RegExp(`<a href="/videos/play/wwdc${year}/(\\d+)/"[^>]*>([\\s\\S]*?)</a>`, 'g');
  let match;
  while ((match = cardRe.exec(html)) !== null) {
    const [, id, body] = match;
    const title = firstMatch(body, /<h5 class="vc-card__title">([\s\S]*?)<\/h5>/);
    const duration = firstMatch(body, /<span class="vc-card__duration">([\s\S]*?)<\/span>/);
    const category = firstMatch(match[0], /data-category="([^"]*)"/);
    const topics = firstMatch(body, /data-filter-topics="([^"]*)"/);
    const description = firstMatch(body, /data-filter-description-en="([^"]*)"/);

    sessions.push({
      id,
      year,
      title: decodeEntities(title).trim(),
      url: `${BASE}/videos/play/wwdc${year}/${id}/`,
      duration: decodeEntities(duration).trim(),
      topics: topics ? decodeEntities(topics).split('|').map(t => t.trim()).filter(Boolean) : [],
      category: category ?? '',
      description: decodeEntities(description).trim(),
    });
  }
  return sessions;
}

function firstMatch(value, regex) {
  const match = value.match(regex);
  return match ? match[1] : '';
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, ' ');
}

/** Latest year present in the bundled index. */
async function readLocalState() {
  const index = await readJson(path.join(DATA_DIR, 'index.json'));
  const allVideos = await readJson(path.join(DATA_DIR, 'all-videos.json'));
  const topics = await readJson(path.join(DATA_DIR, 'topics.json'));
  const byId = new Map();
  for (const video of allVideos.videos ?? []) {
    byId.set(`${video.year}-${video.id}`, video);
  }
  const years = [...(index.years ?? [])].map(String).sort((a, b) => Number(b) - Number(a));
  return { index, allVideos, topics, byId, years };
}

/** Which years to scan: explicit --year values, else newest local year .. current+1. */
function yearsToScan(explicitYears, localYears) {
  if (explicitYears.length > 0) {
    return [...new Set(explicitYears)].sort();
  }
  const newestLocal = Number(localYears[0] ?? new Date().getUTCFullYear() - 1);
  const currentYear = new Date().getUTCFullYear();
  const start = Math.min(newestLocal, currentYear + 1);
  const end = currentYear + 1;
  const years = [];
  for (let year = start; year <= end; year++) {
    years.push(String(year));
  }
  return years;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.dataDir) {
    DATA_DIR = path.resolve(options.dataDir);
    VIDEOS_DIR = path.join(DATA_DIR, 'videos');
  }
  const local = await readLocalState();
  const years = yearsToScan(options.years, local.years);
  console.log(`Bundled snapshot: ${local.index.lastUpdated} · ${local.index.totalVideos} sessions · years ${local.years.at(-1)}–${local.years[0]}`);
  console.log(`Scanning ${years.join(', ')} ...\n`);

  const catalog = new Map(); // `${year}-${id}` -> session
  for (const year of years) {
    const url = `${BASE}/videos/wwdc${year}/`;
    try {
      const html = await fetchText(url, options.timeoutMs);
      const sessions = parseYearPage(html, year);
      for (const session of sessions) {
        catalog.set(`${year}-${session.id}`, session);
      }
      console.log(`${year}: ${sessions.length} sessions on the live page`);
    } catch (error) {
      console.log(`${year}: could not read ${url} (${error.message})`);
    }
  }

  const newSessions = [...catalog.entries()].filter(([key]) => !local.byId.has(key)).map(([, session]) => session);
  const newByYear = new Map();
  for (const session of newSessions) {
    newByYear.set(session.year, (newByYear.get(session.year) ?? 0) + 1);
  }

  console.log('\nNew sessions not present in the bundled snapshot:');
  if (newSessions.length === 0) {
    console.log('  (none)');
  } else {
    for (const [year, count] of [...newByYear.entries()].sort((a, b) => Number(b[0]) - Number(a[0]))) {
      const ids = newSessions.filter(session => session.year === year).map(session => session.id);
      console.log(`  ${year}: ${count} (${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''})`);
    }
  }

  if (options.json) {
    const payload = {
      generatedAt: new Date().toISOString(),
      scannedYears: years,
      newSessionCount: newSessions.length,
      newSessions,
    };
    await writeJson(path.resolve(options.json), payload);
    console.log(`\nWrote catalog report to ${options.json}`);
  }

  if (options.writeCatalog) {
    await writeCatalog({ local, catalog, newSessions, years });
  } else if (newSessions.length > 0) {
    console.log('\nAudit only: nothing was written. Pass --write-catalog to update data/wwdc/* (release decision).');
    console.log('Note: per-session transcripts/code are NOT in Apple\'s static HTML; new sessions would be listed with hasTranscript/hasCode=false until that source is automated.');
  }
}

/** Merge the live catalog into data/wwdc/* without inventing session content. */
async function writeCatalog({ local, catalog, newSessions, years }) {
  const allVideos = [...(local.allVideos.videos ?? [])];
  const known = new Set(allVideos.map(video => `${video.year}-${video.id}`));
  const dataFileExists = new Set();
  for (const entry of await fs.readdir(VIDEOS_DIR)) {
    dataFileExists.add(entry);
  }

  let addedWithoutData = 0;
  for (const [key, session] of catalog) {
    if (known.has(key)) {
      continue;
    }
    const dataFile = `videos/${session.year}-${session.id}.json`;
    const hasData = dataFileExists.has(`${session.year}-${session.id}.json`);
    if (!hasData) {
      addedWithoutData++;
    }
    allVideos.push({
      id: session.id,
      year: session.year,
      title: session.title,
      topics: session.topics,
      duration: session.duration,
      hasCode: false,
      hasTranscript: hasData,
      url: session.url,
      dataFile: hasData ? dataFile : null,
    });
  }

  allVideos.sort((a, b) => (Number(b.year) - Number(a.year)) || (Number(a.id) - Number(b.id)));
  await writeJson(path.join(DATA_DIR, 'all-videos.json'), { videos: allVideos });

  const byYear = new Map();
  const byTopicName = new Map();
  for (const video of allVideos) {
    if (!byYear.has(video.year)) {
      byYear.set(video.year, []);
    }
    byYear.get(video.year).push(video);
    for (const topic of video.topics ?? []) {
      if (!byTopicName.has(topic)) {
        byTopicName.set(topic, []);
      }
      byTopicName.get(topic).push(video);
    }
  }

  const allYears = [...byYear.keys()].sort((a, b) => Number(b) - Number(a));
  for (const year of allYears) {
    const videos = byYear.get(year);
    const topicNames = [...new Set(videos.flatMap(video => video.topics ?? []))].sort();
    await writeJson(path.join(DATA_DIR, 'by-year', year, 'index.json'), {
      year,
      videoCount: videos.length,
      topics: topicNames,
      videos,
    });
  }

  for (const topic of local.topics) {
    const videos = (byTopicName.get(topic.name) ?? []).sort(
      (a, b) => (Number(b.year) - Number(a.year)) || (Number(a.id) - Number(b.id)),
    );
    await writeJson(path.join(DATA_DIR, 'by-topic', topic.id, 'index.json'), {
      id: topic.id,
      name: topic.name,
      videoCount: videos.length,
      years: [...new Set(videos.map(video => video.year))].sort((a, b) => Number(b) - Number(a)),
      videos,
    });
  }

  const statistics = {
    byTopic: Object.fromEntries(local.topics.map(topic => [topic.id, (byTopicName.get(topic.name) ?? []).length])),
    byYear: Object.fromEntries(allYears.map(year => [year, byYear.get(year).length])),
  };
  const index = {
    ...local.index,
    lastUpdated: new Date().toISOString(),
    totalVideos: allVideos.length,
    years: allYears,
    statistics,
  };
  await writeJson(path.join(DATA_DIR, 'index.json'), index);

  console.log(`\nWrote catalog: ${allVideos.length} sessions across ${allYears.length} years.`);
  if (addedWithoutData > 0) {
    console.log(`WARNING: ${addedWithoutData} new session(s) have no data file; their transcripts/code are unavailable until the session-content source is automated.`);
  }
  console.log(`Scanned years: ${years.join(', ')}`);
}

main().catch((error) => {
  console.error(`refresh-wwdc-catalog failed: ${error.message}`);
  process.exit(1);
});
