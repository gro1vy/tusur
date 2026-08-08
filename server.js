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
const TPU_BASE = 'https://apply.tpu.ru/api';
const TSU_BASE = 'https://ratings.tsu.ru';

const UNIVERSITIES = [
  { id: 'tusur', name: 'ТУСУР' },
  { id: 'tpu', name: 'ТПУ' },
  { id: 'tsu', name: 'ТГУ' }
];

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

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeTusurApplicant(applicant, group) {
  return {
    universityId: 'tusur',
    universityName: 'ТУСУР',
    code: String(applicant.sspvo_unique_code || '').trim(),
    index: toNumber(applicant.index),
    rating: applicant.rating,
    examMarksSum: applicant.exam_marks_sum,
    achievements: applicant.individual_achievements_marks_sum,
    priority: toNumber(applicant.priority),
    isHighestPriority: applicant.is_highest_priority,
    isHighestPassingPriority: applicant.is_highest_passing_priority,
    hasAgreement: applicant.has_agreement,
    hasContract: applicant.has_contract,
    status: applicant.status,
    groupId: group.id,
    groupKey: `tusur:${group.id}`,
    direction: group.direction,
    profiles: group.profiles || [],
    groupName: group.name,
    budgetPlaces: group.budget_places,
    payPlaces: group.pay_places
  };
}

function normalizeTpuApplicant(applicant, group, index) {
  return {
    universityId: 'tpu',
    universityName: 'ТПУ',
    code: String(applicant.unique_code_profile || '').trim(),
    index: index + 1,
    rating: toNumber(applicant.sum_all),
    examMarksSum: toNumber(applicant.vi_sum),
    achievements: toNumber(applicant.id_sum),
    priority: toNumber(applicant.prioritet),
    isHighestPriority: Boolean(applicant.top_prioritet),
    isHighestPassingPriority: Boolean(applicant.hp_prioritet),
    hasAgreement: applicant.status_dok_label === 'Оригинал' || applicant.status_dok_label === 'Электронное',
    hasContract: Boolean(applicant.is_dogovor || applicant.is_dogovor_ok),
    status: applicant.status_label,
    groupId: group.id,
    groupKey: `tpu:${group.id}`,
    direction: group.direction,
    profiles: group.profiles || [],
    groupName: group.name,
    budgetPlaces: group.budget_places,
    payPlaces: group.pay_places
  };
}

function normalizeTsuApplicant(cells, group) {
  const fixedTailLength = 9;
  const examCells = cells.slice(2, Math.max(2, cells.length - fixedTailLength));
  const tail = cells.slice(-fixedTailLength);
  const examMarksSum = examCells.reduce((sum, value) => sum + toNumber(value), 0);
  const achievements = toNumber(tail[0]);

  return {
    universityId: 'tsu',
    universityName: 'ТГУ',
    code: String(cells[1] || '').trim(),
    index: toNumber(cells[0]),
    rating: toNumber(tail[1]),
    examMarksSum,
    achievements,
    priority: toNumber(tail[2]),
    isHighestPriority: tail[3] === '1' || /^да$/i.test(tail[3]),
    isHighestPassingPriority: false,
    hasAgreement: /^да$/i.test(tail[4]),
    hasContract: false,
    status: 'Участвует в конкурсе',
    groupId: group.id,
    groupKey: `tsu:${group.id}`,
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

async function fetchText(url) {
  const response = await fetch(url, { headers: { accept: 'text/html,*/*' } });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }

  return response.text();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function textFromHtml(value) {
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function readCache() {
  if (!existsSync(CACHE_FILE)) {
    return null;
  }

  const cache = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
  return cache.version === 2 ? cache : null;
}

async function writeCache(cache) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await mapper(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function refreshTusur() {
  const overview = await fetchJson(TUSUR_BASE);
  const groups = overview.contest_groups || [];
  const details = await mapLimit(groups, 8, async (group) => {
    const data = await fetchJson(`${TUSUR_BASE}/contest_groups/${group.id}`);
    const detailedGroup = data.contest_group;
    const abiturients = detailedGroup.abiturients || [];

    return {
      ...group,
      universityId: 'tusur',
      universityName: 'ТУСУР',
      groupKey: `tusur:${group.id}`,
      name: detailedGroup.name,
      places: detailedGroup.places,
      budget_places: toNumber(detailedGroup.budget_places),
      pay_places: toNumber(detailedGroup.pay_places),
      abiturients: abiturients.map((applicant) => normalizeTusurApplicant(applicant, detailedGroup))
    };
  });

  return {
    sourceGeneratedAt: overview.generated_at,
    groups: details
  };
}

async function refreshTpu() {
  const overview = await fetchJson(`${TPU_BASE}/competition/admission-info`);
  const rows = overview.body?.rows || [];
  const programGroups = rows.flatMap((row) => {
    const children = row.children?.length ? row.children : [row];

    return children.map((child) => ({
      id: child.id,
      universityId: 'tpu',
      universityName: 'ТПУ',
      groupKey: `tpu:${child.id}`,
      direction: `${row.code_special} ${row.direction}`,
      profiles: child.education_program ? [child.education_program] : [],
      name: child.education_program || row.direction,
      department: child.department_name,
      budget_places: toNumber(child.info?.budget ?? row.info?.budget),
      pay_places: toNumber(child.info?.contract ?? row.info?.contract)
    }));
  }).filter((group) => group.budget_places > 0);

  const groups = await mapLimit(programGroups, 5, async (group) => {
    const header = await fetchJson(`${TPU_BASE}/competition/header?competition_id=${group.id}`);
    const budgetCompetition = header.body?.data?.competition_list?.find((item) => Number(item.place_type_id) === 6);
    const admissionConditionId = budgetCompetition?.admission_condition_id || header.body?.data?.admission_condition_id;
    const placeTypeId = budgetCompetition?.place_type_id || header.body?.data?.place_type_id || 6;

    if (!admissionConditionId) {
      return { ...group, abiturients: [] };
    }

    const listUrl = new URL(`${TPU_BASE}/entity/view`);
    listUrl.searchParams.set('slug', 'ranked_competitive_group_list');
    listUrl.searchParams.set('admission_condition_id', admissionConditionId);
    listUrl.searchParams.set('place_type_id', placeTypeId);
    listUrl.searchParams.set('per-page', '10000');

    const list = await fetchJson(listUrl.toString());
    const applicants = list.body?.data || [];

    const budgetPlaces = toNumber(header.body?.data?.mest, group.budget_places);

    return {
      ...group,
      budget_places: budgetPlaces,
      abiturients: applicants.map((applicant, index) => normalizeTpuApplicant(applicant, { ...group, budget_places: budgetPlaces }, index))
    };
  });

  return {
    sourceGeneratedAt: new Date().toLocaleString('ru-RU'),
    groups
  };
}

function parseTsuPrograms(html) {
  const fulltimeSection = html.split('id="tab-0"')[1]?.split('id="tab-1"')[0] || html;
  const rows = [...fulltimeSection.matchAll(/<tr class="text-left">([\s\S]*?)<\/tr>/g)];

  return rows.map(([, row]) => {
    const href = row.match(/href="\/study_stage\/programs\/master\/group-ratings\/([^"]+)"/)?.[1];
    const direction = textFromHtml(row.match(/<strong>([\s\S]*?)<\/strong>/)?.[1]);
    const profile = textFromHtml(row.match(/<div>([\s\S]*?)<\/div>/)?.[1]);
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => textFromHtml(match[1]));

    if (!href || !direction) {
      return null;
    }

    return {
      id: href,
      universityId: 'tsu',
      universityName: 'ТГУ',
      groupKey: `tsu:${href}`,
      direction,
      profiles: profile ? [profile] : [],
      name: profile || direction,
      budget_places: toNumber(cells[1]),
      pay_places: toNumber(cells[4])
    };
  }).filter((group) => group && group.budget_places > 0);
}

function parseTsuBudgetApplicants(html, group) {
  const budgetTable = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];

  if (!budgetTable) {
    return [];
  }

  return [...budgetTable.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => textFromHtml(match[1]));
    return cells.length >= 11 ? normalizeTsuApplicant(cells, group) : null;
  }).filter((applicant) => applicant?.code);
}

async function refreshTsu() {
  const overviewHtml = await fetchText(`${TSU_BASE}/study_stage/programs/master`);
  const programGroups = parseTsuPrograms(overviewHtml);
  const groups = await mapLimit(programGroups, 5, async (group) => {
    const html = await fetchText(`${TSU_BASE}/study_stage/programs/master/group-ratings/${group.id}`);
    return {
      ...group,
      abiturients: parseTsuBudgetApplicants(html, group)
    };
  });

  return {
    sourceGeneratedAt: new Date().toLocaleString('ru-RU'),
    groups
  };
}

function buildApplicantsByCode(groups) {
  const applicantsByCode = {};

  for (const group of groups) {
    for (const applicant of group.abiturients) {
      if (!applicant.code) continue;
      applicantsByCode[applicant.code] ||= [];
      applicantsByCode[applicant.code].push(applicant);
    }
  }

  for (const applications of Object.values(applicantsByCode)) {
    applications.sort((a, b) => {
      const byUniversity = a.universityName.localeCompare(b.universityName, 'ru');
      if (byUniversity) return byUniversity;
      return Number(a.priority || 999) - Number(b.priority || 999);
    });
  }

  return applicantsByCode;
}

async function refreshCache() {
  const [tusur, tpu, tsu] = await Promise.all([refreshTusur(), refreshTpu(), refreshTsu()]);
  const groups = [...tusur.groups, ...tpu.groups, ...tsu.groups];
  const applicantsByCode = buildApplicantsByCode(groups);

  const cache = {
    version: 2,
    refreshedAt: new Date().toISOString(),
    sourceGeneratedAt: `ТУСУР: ${tusur.sourceGeneratedAt}; ТПУ: ${tpu.sourceGeneratedAt}; ТГУ: ${tsu.sourceGeneratedAt}`,
    universities: UNIVERSITIES,
    groups,
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
