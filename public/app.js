function readUserSettings(username) {
  if (!username) {
    return {};
  }

  try {
    return JSON.parse(localStorage.getItem(`user:${username}`) || '{}');
  } catch {
    return {};
  }
}

const initialUsername = localStorage.getItem('currentUsername') || '';
const initialSettings = readUserSettings(initialUsername);

const state = {
  cache: null,
  username: initialUsername,
  selectedGroupId: initialSettings.selectedGroupId || '',
  myCode: initialSettings.myCode || '',
  expandedCodes: new Set()
};

const elements = {
  refreshButton: document.querySelector('#refreshButton'),
  switchUserButton: document.querySelector('#switchUserButton'),
  usernameBadge: document.querySelector('#usernameBadge'),
  groupSelect: document.querySelector('#groupSelect'),
  startGroupSelect: document.querySelector('#startGroupSelect'),
  myCodeInput: document.querySelector('#myCodeInput'),
  startUsernameInput: document.querySelector('#startUsernameInput'),
  startCodeInput: document.querySelector('#startCodeInput'),
  onlyPriorityMoreThanOne: document.querySelector('#onlyPriorityMoreThanOne'),
  searchInput: document.querySelector('#searchInput'),
  stats: document.querySelector('#stats'),
  myCard: document.querySelector('#myCard'),
  applicants: document.querySelector('#applicants'),
  tableHint: document.querySelector('#tableHint'),
  startModal: document.querySelector('#startModal'),
  startForm: document.querySelector('#startForm'),
  toast: document.querySelector('#toast')
};

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove('visible'), 3500);
}

function groupTitle(group) {
  return `${group.direction} - ${(group.profiles || []).join('; ')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[char]));
}

function selectedGroup() {
  return state.cache?.groups.find((group) => group.id === state.selectedGroupId) || null;
}

function applicationsFor(code) {
  return state.cache?.applicantsByCode[String(code)] || [];
}

function applyUserSettings(username) {
  const settings = readUserSettings(username);

  state.username = username;
  state.selectedGroupId = settings.selectedGroupId || '';
  state.myCode = settings.myCode || '';
  state.expandedCodes.clear();
}

function groupById(groupId) {
  return state.cache?.groups.find((group) => group.id === groupId) || null;
}

function priorityBreakdownAbove(application) {
  const group = groupById(application.groupId);

  if (!group) {
    return '-';
  }

  const position = Number(application.index);
  const counts = new Map();

  for (const applicant of group.abiturients || []) {
    if (Number(applicant.index) >= position) continue;

    const priority = Number(applicant.priority);
    if (priority <= 1 || Number.isNaN(priority)) continue;

    counts.set(priority, (counts.get(priority) || 0) + 1);
  }

  if (!counts.size) {
    return 'нет';
  }

  return [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([priority, count]) => `${priority}: ${count}`)
    .join(', ');
}

function renderOptions(select) {
  select.innerHTML = '';

  for (const group of state.cache?.groups || []) {
    const option = document.createElement('option');
    option.value = group.id;
    option.textContent = groupTitle(group);
    select.append(option);
  }
}

function renderStats() {
  const group = selectedGroup();
  const applicants = group?.abiturients || [];
  const priorityMoreThanOne = applicants.filter((item) => Number(item.priority) > 1).length;
  const codesWithOtherApplications = applicants.filter((item) => applicationsFor(item.code).some((app) => app.groupId !== group.id)).length;

  elements.stats.innerHTML = [
    ['Кеш обновлен', state.cache?.sourceGeneratedAt || 'нет данных'],
    ['Направлений', state.cache?.groups.length || 0],
    ['В выбранном списке', applicants.length],
    ['Приоритет больше 1', priorityMoreThanOne],
    ['Есть другие заявления', codesWithOtherApplications]
  ].map(([label, value]) => `<article class="stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join('');
}

function applicationHtml(application, currentGroupId) {
  const same = application.groupId === currentGroupId;
  return `
    <div class="application">
      <div><span class="badge ${same ? 'good' : ''}">${same ? 'выбранное' : 'другое'}</span></div>
      <div>
        <strong>${escapeHtml(application.direction)}</strong>
        <div class="muted">${escapeHtml(application.profiles.join('; '))}</div>
      </div>
      <div class="badges">
        <span class="badge">приоритет ${escapeHtml(application.priority)}</span>
        <span class="badge">балл ${escapeHtml(application.rating)}</span>
        ${application.hasAgreement ? '<span class="badge good">согласие</span>' : ''}
        ${application.hasContract ? '<span class="badge warn">договор</span>' : ''}
      </div>
    </div>
  `;
}

function otherApplicationsTableHtml(applicant, group) {
  const allApplications = applicationsFor(applicant.code);
  const otherApplications = allApplications.filter((application) => application.groupId !== group.id);

  if (!state.expandedCodes.has(applicant.code)) {
    return '';
  }

  const content = otherApplications.length
    ? otherApplications.map((application) => `
      <tr>
        <td>${escapeHtml(application.priority)}</td>
        <td>${escapeHtml(application.index)}</td>
        <td>${escapeHtml(application.budgetPlaces)}</td>
        <td>${escapeHtml(priorityBreakdownAbove(application))}</td>
        <td>${escapeHtml(application.direction)}</td>
        <td>${escapeHtml(application.profiles.join('; '))}</td>
        <td>${escapeHtml(application.rating)}</td>
        <td>${application.hasAgreement ? 'Да' : 'Нет'}</td>
        <td>${escapeHtml(application.status)}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="9" class="muted">Других направлений для этого кода не найдено.</td></tr>';

  return `
    <tr class="details-row">
      <td colspan="9">
        <div class="details-box">
          <strong>Другие направления по коду ${escapeHtml(applicant.code)}</strong>
          <table class="nested-table">
            <thead>
              <tr>
                <th>Приоритет</th>
                <th>Место</th>
                <th>Бюджетных мест</th>
                <th>Выше с приоритетом 2+</th>
                <th>Направление</th>
                <th>Профиль</th>
                <th>Балл</th>
                <th>Согласие</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>${content}</tbody>
          </table>
        </div>
      </td>
    </tr>
  `;
}

function applicantRowHtml(applicant, group) {
  const allApplications = applicationsFor(applicant.code);
  const otherApplications = allApplications.filter((application) => application.groupId !== group.id);
  const mine = applicant.code === state.myCode;
  const expanded = state.expandedCodes.has(applicant.code);

  return `
    <tr class="contest-row ${mine ? 'mine' : ''}">
      <td>${escapeHtml(applicant.index)}</td>
      <td><strong>${escapeHtml(applicant.code)}</strong>${mine ? '<span class="badge good">мой код</span>' : ''}</td>
      <td>${escapeHtml(applicant.rating)}</td>
      <td>${escapeHtml(applicant.examMarksSum)}</td>
      <td>${escapeHtml(applicant.achievements)}</td>
      <td>${applicant.hasAgreement ? 'Да' : 'Нет'}</td>
      <td>${applicant.isHighestPassingPriority ? 'Да' : 'Нет'}</td>
      <td>
        <span class="priority-cell">
          <span class="priority-value ${Number(applicant.priority) > 1 ? 'warn' : 'good'}">${escapeHtml(applicant.priority)}</span>
          <button class="small-button" type="button" data-code="${escapeHtml(applicant.code)}" ${otherApplications.length ? '' : 'disabled'}>
            ${expanded ? 'Скрыть' : `Другие (${otherApplications.length})`}
          </button>
        </span>
      </td>
      <td>${escapeHtml(applicant.status)}</td>
    </tr>
    ${otherApplicationsTableHtml(applicant, group)}
  `;
}

function applicantRowsHtml(applicants, group) {
  const budgetPlaces = Number(group.budget_places || 0);
  let separatorShown = false;
  const rows = [];

  for (const applicant of applicants) {
    const index = Number(applicant.index);

    if (budgetPlaces > 0 && !separatorShown && index > budgetPlaces) {
      rows.push(`
        <tr class="budget-separator">
          <td colspan="9"><span>Граница бюджетных мест: ${escapeHtml(budgetPlaces)}</span></td>
        </tr>
      `);
      separatorShown = true;
    }

    rows.push(applicantRowHtml(applicant, group));
  }

  if (budgetPlaces > 0 && !separatorShown && applicants.length && Number(applicants.at(-1).index) <= budgetPlaces) {
    rows.push(`
      <tr class="budget-separator">
        <td colspan="9"><span>Граница бюджетных мест: ${escapeHtml(budgetPlaces)}</span></td>
      </tr>
    `);
  }

  return rows.join('');
}

function renderMyCard() {
  if (!state.myCode) {
    elements.myCard.className = 'panel my-card empty';
    elements.myCard.textContent = 'Укажите свой уникальный код.';
    return;
  }

  const applications = applicationsFor(state.myCode);
  elements.myCard.className = applications.length ? 'panel my-card' : 'panel my-card empty';
  elements.myCard.innerHTML = applications.length
    ? `<h2>Мой код: ${escapeHtml(state.myCode)}</h2><div class="applications">${applications.map((application) => applicationHtml(application, state.selectedGroupId)).join('')}</div>`
    : `Код ${escapeHtml(state.myCode)} в кеше не найден.`;
}

function renderApplicants() {
  const group = selectedGroup();

  if (!group) {
    elements.applicants.innerHTML = '<p class="muted">Выберите направление.</p>';
    return;
  }

  const search = elements.searchInput.value.trim();
  const onlyPriorityMoreThanOne = elements.onlyPriorityMoreThanOne.checked;
  const applicants = group.abiturients.filter((applicant) => {
    if (onlyPriorityMoreThanOne && Number(applicant.priority) <= 1) return false;
    if (search && !applicant.code.includes(search)) return false;
    return true;
  });

  elements.tableHint.textContent = `${groupTitle(group)}. Показано ${applicants.length} из ${group.abiturients.length}.`;
  elements.applicants.innerHTML = applicants.length
    ? `
      <div class="table-scroll">
        <table class="contest-table">
          <thead>
            <tr>
              <th>№</th>
              <th>Уникальный код</th>
              <th>Сумма баллов</th>
              <th>Вступительные</th>
              <th>ИД</th>
              <th>Согласие</th>
              <th>Проходит</th>
              <th>Приоритет</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>${applicantRowsHtml(applicants, group)}</tbody>
        </table>
      </div>
    `
    : '<p class="muted">Нет абитуриентов под выбранные условия.</p>';
}

function render() {
  elements.usernameBadge.textContent = state.username || 'не выбран';

  if (!state.cache) {
    elements.groupSelect.innerHTML = '<option>Кеш пуст</option>';
    elements.startGroupSelect.innerHTML = '<option>Кеш пуст</option>';
    elements.stats.innerHTML = '<article class="stat"><span>Кеш</span><strong>пуст</strong></article>';
    elements.myCard.className = 'panel my-card empty';
    elements.myCard.textContent = 'Нажмите «Обновить кеш», чтобы загрузить данные с сайта ТУСУР.';
    elements.applicants.innerHTML = '';
    elements.startUsernameInput.value = state.username;
    elements.startCodeInput.value = state.myCode;
    elements.startModal.classList.add('visible');
    return;
  }

  if (!state.selectedGroupId || !selectedGroup()) {
    state.selectedGroupId = state.cache.groups[0]?.id || '';
  }

  renderOptions(elements.groupSelect);
  renderOptions(elements.startGroupSelect);
  elements.groupSelect.value = state.selectedGroupId;
  elements.startGroupSelect.value = state.selectedGroupId;
  elements.myCodeInput.value = state.myCode;
  elements.startUsernameInput.value = state.username;
  elements.startCodeInput.value = state.myCode;

  renderStats();
  renderMyCard();
  renderApplicants();

  if (!state.username || !state.myCode || !state.selectedGroupId) {
    elements.startModal.classList.add('visible');
  } else {
    elements.startModal.classList.remove('visible');
  }
}

async function loadCache() {
  const response = await fetch('/api/cache');
  const data = await response.json();
  state.cache = data.cache;
  render();
}

async function refreshCache() {
  elements.refreshButton.disabled = true;
  elements.refreshButton.textContent = 'Обновляю...';

  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Не удалось обновить кеш');
    }

    state.cache = data.cache;
    showToast('Кеш обновлен');
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.refreshButton.disabled = false;
    elements.refreshButton.textContent = 'Обновить кеш';
  }
}

function saveSettings(groupId, myCode) {
  state.selectedGroupId = groupId;
  state.myCode = String(myCode || '').trim();

  if (!state.username) {
    return;
  }

  localStorage.setItem('currentUsername', state.username);
  localStorage.setItem(`user:${state.username}`, JSON.stringify({
    selectedGroupId: state.selectedGroupId,
    myCode: state.myCode
  }));
}

elements.refreshButton.addEventListener('click', refreshCache);
elements.switchUserButton.addEventListener('click', () => {
  elements.startUsernameInput.value = '';
  elements.startCodeInput.value = '';
  elements.startModal.classList.add('visible');
});
elements.groupSelect.addEventListener('change', () => {
  saveSettings(elements.groupSelect.value, elements.myCodeInput.value);
  render();
});
elements.myCodeInput.addEventListener('change', () => {
  saveSettings(elements.groupSelect.value, elements.myCodeInput.value);
  render();
});
elements.onlyPriorityMoreThanOne.addEventListener('change', renderApplicants);
elements.searchInput.addEventListener('input', renderApplicants);
elements.startUsernameInput.addEventListener('change', () => {
  const username = elements.startUsernameInput.value.trim();
  const settings = readUserSettings(username);

  elements.startCodeInput.value = settings.myCode || '';

  if (settings.selectedGroupId) {
    elements.startGroupSelect.value = settings.selectedGroupId;
  }
});
elements.applicants.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-code]');

  if (!button) return;

  const code = button.dataset.code;

  if (state.expandedCodes.has(code)) {
    state.expandedCodes.delete(code);
  } else {
    state.expandedCodes.add(code);
  }

  renderApplicants();
});
elements.startForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const username = elements.startUsernameInput.value.trim();

  if (!username) {
    showToast('Введите имя пользователя');
    return;
  }

  applyUserSettings(username);
  state.username = username;
  saveSettings(elements.startGroupSelect.value, elements.startCodeInput.value);
  render();
});

loadCache().catch((error) => showToast(error.message));
