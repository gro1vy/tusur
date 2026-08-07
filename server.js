import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();
const PUBLIC_DIR = join(ROOT, 'public');
const CACHE_DIR = join(ROOT, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'contest-cache.json');
const TUSUR_BASE = 'https://contest.tusur.ru/api/v1/campaigns/magistrant/fulltime';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

let refreshPromise = null;

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function normalizeApplicant(applicant, group) {
  return {
    code: String(applicant.sspvo_unique_code || '').trim(),
    index: applicant.index,
    rating: applicant.rating,
    examMarksSum: applicant.exam_marks_sum,
    achievements: applicant.individual_achievements_marks_sum,
    priority: applicant.priority,
    isHighestPriority: applicant.is_highest_priority,
    isHighestPassingPriority: applicant.is_highest_passing_priority,
    hasAgreement: applicant.has_agreement,
    hasContract: applicant.has_contract,
    status: applicant.status,
    groupId: group.id,
    direction: group.direction,
    profiles: group.profiles || [],
    groupName: group.name,
    budgetPlaces: group.budget_places,
    payPlaces: group.pay_places
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }

  return response.json();
}

async function readCache() {
  if (!existsSync(CACHE_FILE)) {
    return null;
  }

  return JSON.parse(await readFile(CACHE_FILE, 'utf8'));
}

async function writeCache(cache) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function refreshCache() {
  const overview = await fetchJson(TUSUR_BASE);
  const groups = overview.contest_groups || [];
  const details = await Promise.all(groups.map(async (group) => {
    const data = await fetchJson(`${TUSUR_BASE}/contest_groups/${group.id}`);
    const detailedGroup = data.contest_group;
    const abiturients = detailedGroup.abiturients || [];

    return {
      ...group,
      name: detailedGroup.name,
      places: detailedGroup.places,
      abiturients: abiturients.map((applicant) => normalizeApplicant(applicant, detailedGroup))
    };
  }));

  const applicantsByCode = {};

  for (const group of details) {
    for (const applicant of group.abiturients) {
      if (!applicant.code) continue;
      applicantsByCode[applicant.code] ||= [];
      applicantsByCode[applicant.code].push(applicant);
    }
  }

  for (const applications of Object.values(applicantsByCode)) {
    applications.sort((a, b) => Number(a.priority || 999) - Number(b.priority || 999));
  }

  const cache = {
    refreshedAt: new Date().toISOString(),
    sourceGeneratedAt: overview.generated_at,
    campaign: overview.campaign,
    total: overview.total,
    groups: details,
    applicantsByCode
  };

  await writeCache(cache);
  return cache;
}

async function handleApi(req, res) {
  if (req.url === '/api/cache') {
    sendJson(res, 200, { cache: await readCache() });
    return;
  }

  if (req.url === '/api/refresh' && req.method === 'POST') {
    refreshPromise ||= refreshCache().finally(() => {
      refreshPromise = null;
    });

    const cache = await refreshPromise;
    sendJson(res, 200, { cache });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = resolve(PUBLIC_DIR, `.${decodeURIComponent(requestedPath)}`);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}).listen(PORT, () => {
  console.log(`TUSUR helper: http://localhost:${PORT}`);
});
