
// Estado compartilhado e configuração das fontes de dados.
let data = [];
let availableSchools = [];
let availableGrades = [];
let availableDates = [];
let tableRows = [];
let gradeChart = null;
let attendanceChart = null;
let dashboardRequest = 0;
let isConnected = false;
let searchTimer = null;
const additionalGrades = ['2ª Itinerário', '3ª Itinerário'];
const applicationSchedule = {
  '1ª': ['12/11/2026', '13/11/2026'],
  '2ª': ['10/11/2026', '11/11/2026'],
  '3ª': ['04/11/2026', '05/11/2026'],
  '2ª Itinerário': ['09/11/2026'],
  '3ª Itinerário': ['06/11/2026'],
  '6º': ['18/11/2026', '19/11/2026'],
  '7º': ['26/11/2026', '27/11/2026'],
  '8º': ['30/11/2026', '01/12/2026'],
  '9º': ['28/10/2026', '29/10/2026']
};
const itinerarioSourceGrades = {
  '3ª Itinerário': '3º',
  '2ª Itinerário': '2ª'
};
const gradeDisplayLabels = new Map([
  ['1ª', '1ª série'],
  ['2ª', '2ª série'],
  ['3ª', '3ª série'],
  ['2º', '2ª série'],
  ['3º', '3ª série'],
  ['2ª itinerário', '2ª Itinerário'],
  ['3ª itinerário', '3ª Itinerário']
]);

const $ = id => document.getElementById(id);
const fmt = value => Number(value || 0).toLocaleString('pt-BR');
const apiBaseUrl = String(window.PAINEL_API_URL || '').replace(/\/+$/, '');
const sheetSources = Array.isArray(window.PAINEL_SHEET_CSV_URLS)
  ? window.PAINEL_SHEET_CSV_URLS.filter(source =>
    source && typeof source.url === 'string' && source.url.trim()
  )
  : window.PAINEL_SHEET_CSV_URL
    ? [{ url: window.PAINEL_SHEET_CSV_URL, grade: '' }]
    : [];
const sheetCsvUrl = sheetSources.length > 0;
const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const pct = value => (value * 100).toLocaleString('pt-BR', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1
}) + '%';

// Utilitários de formatação e normalização dos filtros.
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'pt-BR', { numeric: true }));
}

function sortGrades(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => {
    const gradeSortKey = value => {
      const label = String(value).trim().toLocaleLowerCase('pt-BR');
      const number = Number(label.match(/^\d+/)?.[0]);
      if (label.includes('itinerário')) return number === 2 ? 3 : 4;
      return ({ 1: 0, 2: 1, 3: 2, 6: 5, 7: 6, 8: 7, 9: 8 })[number] ?? 9;
    };
    return gradeSortKey(left) - gradeSortKey(right);
  });
}

function gradeDisplayLabel(value) {
  const grade = String(value ?? '').trim();
  const normalized = grade.toLocaleLowerCase('pt-BR');
  if (gradeDisplayLabels.has(normalized)) return gradeDisplayLabels.get(normalized);
  const number = Number(normalized.match(/^\d+/)?.[0]);
  if (normalized.includes('itinerário') && [2, 3].includes(number)) {
    return `${number}ª Itinerário`;
  }
  if ([1, 2, 3].includes(number)) return `${number}ª série`;
  if ([6, 7, 8, 9].includes(number)) return `${number}º ano`;
  return grade;
}

function gradeMatchesFilter(rowGrade, selectedGrade) {
  if (!selectedGrade) return true;
  return rowGrade === selectedGrade ||
    (itinerarioSourceGrades[selectedGrade] &&
      rowGrade === itinerarioSourceGrades[selectedGrade]);
}

function scheduledDatesForGrade(grade) {
  const normalized = String(grade || '').trim().toLocaleLowerCase('pt-BR');
  const match = normalized.match(/^(\d+)\s*[ºª]/);
  if (!match) return [];
  const number = match[1];
  const key = normalized.includes('itinerário')
    ? `${number}ª Itinerário`
    : `${number}${['6', '7', '8', '9'].includes(number) ? 'º' : 'ª'}`;
  return applicationSchedule[key] || [];
}

function isGradeLabel(value) {
  return /^\d+\s*[ºª](?:\s*(?:ano|série|itinerário))?$/iu.test(String(value ?? '').trim());
}

function fill(id, values, firstLabel) {
  const element = $(id);
  if (!element) return;
  const previous = element.value;
  element.innerHTML = `<option value="">${firstLabel}</option>` +
    values.map(value => `<option value="${esc(value)}">${esc(id === 'grade' ? gradeDisplayLabel(value) : value)}</option>`).join('');
  if (values.includes(previous)) element.value = previous;
}

function datesForGrade(grade) {
  if (!grade) return availableDates;
  const scheduledDates = scheduledDatesForGrade(grade);
  if (scheduledDates.length) return scheduledDates;
  const synchronizedDates = new Set(data
    .filter(row =>
      gradeMatchesFilter(row.grade, grade) &&
      ['initial', 'transfers', 'evaded', 'planned', 'present', 'absent']
        .some(metric => Number(row[metric]) > 0)
    )
    .map(row => row.day));
  return availableDates.filter(day => synchronizedDates.has(day));
}

function fillAvailableDays() {
  const dates = datesForGrade($('grade').value);
  const selectedDay = $('day').value;
  fill('day', dates, 'Todos');
  if (selectedDay && !dates.includes(selectedDay)) $('day').value = '';
}

function fillTurmas() {
  const school = $('school').value;
  const grade = $('grade').value;
  const available = data.filter(row =>
    row.type === 'TURMA' &&
    (!school || row.school === school) &&
    (!grade || row.grade === grade)
  );
  fill('turma', uniq(available.map(row => row.turma)), 'Todas');
}

function syncItinerarioFilter(source) {
  const grade = $('grade').value;
  const day = $('day').value;
  const itineraryDates = scheduledDatesForGrade(grade);
  if (source === 'grade' && normalizedGradeIsItinerary(grade) &&
      itineraryDates.length && datesForGrade(grade).includes(itineraryDates[0])) {
    $('day').value = itineraryDates[0];
  } else if (source === 'day') {
    const scheduledGrade = Object.keys(applicationSchedule)
      .find(candidate => normalizedGradeIsItinerary(candidate) &&
        scheduledDatesForGrade(candidate).includes(day));
    if (scheduledGrade && availableGrades.includes(scheduledGrade) &&
        datesForGrade(scheduledGrade).includes(day)) {
      $('grade').value = scheduledGrade;
    }
  }
}

function normalizedGradeIsItinerary(grade) {
  return String(grade || '').toLocaleLowerCase('pt-BR').includes('itinerário');
}

// Avisos de sincronização, qualidade e disponibilidade dos dados.
function showNotice(message, isError = false) {
  $('notice').classList.toggle('error', isError);
  $('notice').textContent = message;
}

function missingApiError() {
  return new Error(
    'A interface está publicada, mas ainda não há uma API institucional configurada. ' +
    'Configure a variável PAINEL_API_URL no GitHub Actions após a equipe de TI disponibilizar uma API segura.'
  );
}

function showQualityNotice(quality, result) {
  const messages = [];
  const filters = currentFilters();
  if (!result.rows.length && filters.school && filters.grade && filters.day) {
    messages.push(
      `Não há dados preenchidos na planilha para ${filters.grade} na unidade ` +
      `${filters.school} em ${filters.day}. Verifique a aba do itinerário na planilha Google.`
    );
  }
  if (quality.negativeAbsences) {
    messages.push(
      `${fmt(quality.negativeAbsences)} registro(s) da base têm ausência negativa; ` +
      'esses valores foram considerados zero, pois não representam alunos ausentes.'
    );
  }
  if (quality.presentOverPlanned) {
    messages.push(
      `${fmt(quality.presentOverPlanned)} registro(s) têm presença maior que o previsto final; ` +
      'os valores originais foram mantidos.'
    );
  }
  if (messages.length) {
    showNotice(
      messages.join(' '),
      Boolean(quality.negativeAbsences || quality.presentOverPlanned)
    );
  } else if (sheetCsvUrl && $('school').value && isRegionalCsvData()) {
    showNotice(
      'Unidade selecionada para visualização. A fonte atual contém somente totais regionais; ' +
      'os indicadores exibidos não são específicos desta escola.'
    );
  } else {
    showNotice(
      sheetCsvUrl
        ? `Planilha Google sincronizada. Dados agregados ${isRegionalCsvData() ? 'por série e dia' : 'por unidade, série e dia'}; filtros e gráficos atualizados.`
        : 'Planilha conectada. Totais consolidados a partir das abas de turma; filtros aplicados antes dos cálculos.'
    );
  }
}

function isRegionalCsvData() {
  return Boolean(data.length) && data.every(row => row.school === 'Total regional');
}

async function requestJson(url, options = {}) {
  if (apiBaseUrl) {
    let apiUrl;
    try {
      apiUrl = new URL(apiBaseUrl);
    } catch {
      throw new Error(
        'PAINEL_API_URL precisa ser o endereço base HTTPS da API (por exemplo, https://servico.azurewebsites.net), ' +
        'não uma chave de API nem o link publicado da planilha.'
      );
    }
    if (apiUrl.protocol !== 'https:' || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
      throw new Error(
        'PAINEL_API_URL deve ser uma URL base HTTPS, sem credenciais, chave ou parâmetros. ' +
        'O link publicado da planilha não implementa a API do painel.'
      );
    }
  }
  const endpoint = apiBaseUrl ? `${apiBaseUrl}${url}` : url;
  let response;
  try {
    response = await fetch(endpoint, { cache: 'no-store', ...options });
  } catch {
    if (apiBaseUrl) {
      throw new Error(
        'Não foi possível conectar à API configurada. Verifique se o serviço está disponível ' +
        'e permite o domínio do GitHub Pages via CORS.'
      );
    }
    if (!isLocalHost) throw missingApiError();
    throw new Error(
      'Não foi possível acessar o servidor local do painel. Inicie server.py com Python ' +
      'na pasta do painel e abra http://127.0.0.1:8000/. Não use “Go Live” nem abra o HTML diretamente.'
    );
  }

  let result = {};
  try {
    result = await response.json();
  } catch {
    if (response.ok) throw new Error('O servidor retornou uma resposta inválida.');
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      if (apiBaseUrl) {
        throw new Error(
          `A API configurada não oferece o endereço solicitado (${response.status}). ` +
          'Confirme com a equipe de TI se os endpoints do painel estão publicados.'
        );
      }
      if (!isLocalHost) throw missingApiError();
      throw new Error(
        'Endereço incorreto: esta página não está conectada ao servidor do painel ' +
        `(HTTP ${response.status}). Inicie server.py com Python e abra http://127.0.0.1:8000/.`
      );
    }
    throw new Error(result.error || `Falha na solicitação (${response.status}).`);
  }
  return result;
}

// Leitura do CSV publicado e conversão para o formato interno do painel.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"' && value === '') {
      quoted = true;
    } else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value);
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error('A planilha Google retornou um CSV com aspas inválidas.');
  if (value || row.length) {
    row.push(value);
    if (row.some(cell => cell.trim())) rows.push(row);
  }
  return rows;
}

function parsePublishedSheet(csv, defaultGrade = '', view = 'TURMA') {
  const rows = parseCsv(csv.replace(/^\uFEFF/, ''));
  const monthNumbers = {
    jan: '01', fev: '02', mar: '03', abr: '04', mai: '05', jun: '06',
    jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12'
  };
  const normalized = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim().toUpperCase();
  const isTotalSchool = value => normalized(value).includes('TOTAL');
  const gradePattern = /^(\d+)\s*[ºª]\s*SERIE$/i;
  const normalizeGrade = value => {
    const grade = String(value || '').trim();
    const match = grade.match(/^(\d+)\s*[ºª]/);
    const defaultMatch = defaultGrade.match(/^(\d+)\s*[ºª]/);
    return match && defaultMatch && match[1] === defaultMatch[1] ? defaultGrade : grade || defaultGrade;
  };
  const counts = value => {
    const digits = String(value || '').trim().replace(/[.,\s]/g, '');
    return /^\d+$/.test(digits) ? Number(digits) : null;
  };
  const dayValue = value => {
    const match = normalized(value).toLowerCase()
      .match(/^(\d{1,2})[-/ ]+([a-z]{3})\.?(?:[-/ ]+(20\d{2}))?$/);
    if (!match || !monthNumbers[match[2]]) return '';
    return `${match[1].padStart(2, '0')}/${monthNumbers[match[2]]}/${match[3] || '2026'}`;
  };
  const detailHeader = rows.findIndex(cells =>
    cells.some(cell => normalized(cell) === 'UNIDADE ESCOLAR') &&
    cells.some(cell => dayValue(cell))
  );
  if (detailHeader >= 0) {
    const dateHeader = rows[detailHeader];
    const headers = (rows[detailHeader + 1] || []).map(normalized);
    const schoolIndex = dateHeader.findIndex(cell => normalized(cell) === 'UNIDADE ESCOLAR');
    const dateGroups = dateHeader
      .map((cell, index) => ({ index, day: dayValue(cell) }))
      .filter(item => item.day);
    const metricIndices = {
      grade: value => /^(?:ANO\/)?SERIE$/.test(value),
      turma: value => value === 'TURMA',
      period: value => value === 'PERIODO',
      initial: value => /PREV.*INICIAL/.test(value),
      transfers: value => /TRANSFER/.test(value),
      evaded: value => /EVAD/.test(value),
      planned: value => /PREV.*FINAL/.test(value),
      present: value => /^PRESENT/.test(value),
      absent: value => /^AUSENT/.test(value)
    };
    const groups = dateGroups.map((date, index) => {
      const end = dateGroups[index + 1]?.index ?? headers.length;
      const indices = {};
      for (const [field, matches] of Object.entries(metricIndices)) {
        indices[field] = headers.findIndex((header, headerIndex) =>
          headerIndex >= date.index && headerIndex < end && matches(header)
        );
      }
      return { day: date.day, indices };
    });
    const output = [];
    const schools = [...new Set(rows.slice(detailHeader + 2)
      .map(cells => String(cells[schoolIndex] || '').trim())
      .filter(school => school && !isTotalSchool(school)))];
    const yearMatch = rows.slice(0, detailHeader + 2).flat().join(' ').match(/\b(20\d{2})\b/);
    const year = yearMatch?.[1] || '2026';

    for (const cells of rows.slice(detailHeader + 2)) {
      const school = String(cells[schoolIndex] || '').trim();
      if (!school || isTotalSchool(school)) continue;
      for (const group of groups) {
        const { indices } = group;
        const values = Object.fromEntries(
          Object.entries(indices).map(([field, index]) => [
            field,
            index < 0 ? null : counts(cells[index])
          ])
        );
        if (['initial', 'transfers', 'evaded', 'planned', 'present']
          .every(field => values[field] === null)) continue;
        const day = `${group.day.slice(0, 6)}${year}`;
        output.push({
          type: view,
          grade: normalizeGrade(cells[indices.grade]),
          school,
          turma: indices.turma < 0 ? '' : String(cells[indices.turma] || '').trim(),
          period: String(cells[indices.period] || '').trim(),
          day,
          initial: values.initial ?? values.planned ?? 0,
          transfers: values.transfers ?? 0,
          evaded: values.evaded ?? 0,
          planned: values.planned ?? 0,
          present: values.present ?? 0,
          absent: values.absent ?? Math.max((values.planned ?? 0) - (values.present ?? 0), 0)
        });
      }
    }

    return {
      rows: output,
      schools,
      grades: uniq([
        defaultGrade,
        ...output.map(row => row.grade)
      ].filter(isGradeLabel)),
      dates: [...new Set(dateGroups.map(group => `${group.day.slice(0, 6)}${year}`))].sort((left, right) => {
        const [leftDay, leftMonth, leftYear] = left.split('/').map(Number);
        const [rightDay, rightMonth, rightYear] = right.split('/').map(Number);
        return Date.UTC(leftYear, leftMonth - 1, leftDay) - Date.UTC(rightYear, rightMonth - 1, rightDay);
      }),
      updatedAt: new Date().toISOString()
    };
  }

  let grade = '';
  const dataRows = [];

  for (const cells of rows) {
    const gradeCell = normalized(cells[4] || '');
    const gradeMatch = gradeCell.match(gradePattern);
    if (gradeMatch) {
      grade = `${gradeMatch[1]}ª Série`;
      continue;
    }

    const dayCell = normalized(cells[5] || '').toLowerCase();
    const parsedDay = dayValue(dayCell);
    const planned = counts(cells[6]);
    const present = counts(cells[7]);
    if (!grade || !parsedDay || dayCell.startsWith('total') || planned === null || present === null) continue;

    const day = parsedDay;
    dataRows.push({
      type: 'TURMA',
      grade,
      school: 'Total regional',
      turma: '',
      period: '',
      day,
      initial: planned,
      transfers: 0,
      evaded: 0,
      planned,
      present,
      absent: Math.max(planned - present, 0)
    });
  }

  if (!dataRows.length) {
    throw new Error(
      'Não encontrei linhas de série, dia, previstos e presentes no CSV publicado. ' +
      'Confirme se o formato da planilha Google continua igual.'
    );
  }
  const dates = [...new Set(dataRows.map(row => row.day))].sort((left, right) => {
    const [leftDay, leftMonth, leftYear] = left.split('/').map(Number);
    const [rightDay, rightMonth, rightYear] = right.split('/').map(Number);
    return Date.UTC(leftYear, leftMonth - 1, leftDay) - Date.UTC(rightYear, rightMonth - 1, rightDay);
  });
  return {
    rows: dataRows,
    dates,
    updatedAt: new Date().toISOString()
  };
}

async function loadPublishedSheet() {
  const results = await Promise.all(sheetSources.map(async source => {
    let response;
    try {
      response = await fetch(source.url, { cache: 'no-store' });
    } catch {
      throw new Error(
        'Não foi possível ler uma das abas da planilha Google. Verifique a publicação como CSV e a conexão de rede.'
      );
    }
    if (!response.ok) {
      throw new Error(`Falha ao ler uma aba da planilha Google (HTTP ${response.status}).`);
    }
    const contentType = response.headers.get('content-type') || '';
    const csv = await response.text();
    if (contentType.includes('text/html') || /^\s*<!doctype html/i.test(csv)) {
      throw new Error('O Google retornou uma página HTML, não CSV. Verifique se todas as abas estão publicadas.');
    }
    return parsePublishedSheet(csv, source.grade, source.view);
  }));
  const dates = uniq(results.flatMap(result => result.dates)).sort((left, right) => {
    const [leftDay, leftMonth, leftYear] = left.split('/').map(Number);
    const [rightDay, rightMonth, rightYear] = right.split('/').map(Number);
    return Date.UTC(leftYear, leftMonth - 1, leftDay) - Date.UTC(rightYear, rightMonth - 1, rightDay);
  });
  return {
    rows: results.flatMap(result => result.rows),
    schools: uniq(results.flatMap(result => result.schools || [])),
    grades: uniq(results.flatMap(result => result.grades || [])),
    dates,
    updatedAt: new Date().toISOString()
  };
}

// Aplicação dos filtros e consolidação dos totais e séries do gráfico.
function aggregatePublishedData(rows, view, filters) {
  const search = String(filters.search || '').toLocaleLowerCase('pt-BR');
  const regionalOnly = rows.length > 0 && rows.every(row => row.school === 'Total regional');
  const viewRows = regionalOnly ? rows : rows.filter(row => row.type === view);
  const selectedRows = viewRows.filter(row => {
    if (filters.school && !regionalOnly && row.school !== filters.school) return false;
    if (!gradeMatchesFilter(row.grade, filters.grade)) return false;
    if (filters.day && row.day !== filters.day) return false;
    const searchable = [row.school, row.grade, row.period, row.day].join(' ').toLocaleLowerCase('pt-BR');
    return !search || searchable.includes(search);
  });
  const chartRows = viewRows.filter(row =>
    (!filters.school || regionalOnly || row.school === filters.school) &&
    (!search || [row.school, row.grade, row.period, row.day].join(' ').toLocaleLowerCase('pt-BR').includes(search))
  );
  const metrics = ['initial', 'transfers', 'evaded', 'planned', 'present', 'absent'];
  const grouped = new Map();

  for (const row of selectedRows) {
    const key = view === 'ESCOLA'
      ? `${row.school}|${row.grade}|${row.period}|${row.day}`
      : `${row.school}|${row.grade}|${row.turma}|${row.period}|${row.day}`;
    let group = grouped.get(key);
    if (!group) {
      group = {
        type: view,
        school: row.school,
        grade: row.grade || (filters.grade || 'Todas as séries'),
        turma: row.turma || '',
        period: row.period || '',
        day: row.day,
        ...Object.fromEntries(metrics.map(metric => [metric, 0]))
      };
      grouped.set(key, group);
    }
    for (const metric of metrics) group[metric] += row[metric] || 0;
  }

  const resultRows = [...grouped.values()].sort((left, right) =>
    left.school.localeCompare(right.school, 'pt-BR') ||
    left.grade.localeCompare(right.grade, 'pt-BR', { numeric: true }) ||
    Date.UTC(...left.day.split('/').reverse().map(Number)) -
      Date.UTC(...right.day.split('/').reverse().map(Number))
  );
  const totals = filters.day && resultRows.length
    ? Object.fromEntries(metrics.map(metric => [
      metric,
      resultRows.reduce((total, row) => total + row[metric], 0)
    ]))
    : null;
  if (totals) {
    totals.participation = totals.planned ? totals.present / totals.planned : null;
  }

  const gradeTotals = new Map();
  for (const row of chartRows) {
    if (!row.grade) continue;
    let days = gradeTotals.get(row.grade);
    if (!days) {
      days = new Map();
      gradeTotals.set(row.grade, days);
    }
    const values = days.get(row.day) || { planned: 0, present: 0 };
    values.planned += row.planned;
    values.present += row.present;
    days.set(row.day, values);
  }
  const gradeStats = sortGrades([
    ...availableGrades,
    ...gradeTotals.keys()
  ]).map(grade => {
    const days = [...(gradeTotals.get(grade)?.values() || [])]
      .filter(values => values.planned > 0);
    const participation = days.length
      ? days.reduce((total, values) => total + values.present / values.planned, 0) / days.length
      : null;
    return {
      grade,
      planned: days.reduce((total, values) => total + values.planned, 0),
      present: days.reduce((total, values) => total + values.present, 0),
      participation
    };
  });

  return {
    view,
    rows: resultRows,
    totals,
    gradeStats,
    quality: {
      negativeAbsences: 0,
      presentOverPlanned: selectedRows.filter(row => row.planned > 0 && row.present > row.planned).length
    }
  };
}

function currentFilters() {
  return {
    view: $('type').value,
    school: $('school').value,
    grade: $('grade').value,
    turma: $('turma')?.value || '',
    day: $('day').value,
    search: $('search').value
  };
}

// Atualização da interface: resumo, indicadores, gráficos e tabela.
function updatePrintSummary() {
  const filters = currentFilters();
  const labels = [
    ['Visão', filters.view === 'TURMA' ? 'Por turma' : 'Por escola'],
    ['Escola', filters.school],
    ['Ano/Série', filters.grade],
    ['Turma', filters.turma],
    ['Data', filters.day],
    ['Busca', filters.search]
  ].filter(([, value]) => value);

  $('printSummary').textContent = 'Filtros: ' +
    (labels.length ? labels.map(([label, value]) => `${label}: ${value}`).join(' · ') : 'Nenhum');
}

function setMetrics(result) {
  const daySelected = Boolean($('day').value);
  const totals = result.totals;
  $('planned').textContent = daySelected && totals ? fmt(totals.planned) : '—';
  $('present').textContent = daySelected && totals ? fmt(totals.present) : '—';
  $('rate').textContent = daySelected && totals && totals.participation !== null
    ? pct(totals.participation)
    : '—';
  $('planned').nextElementSibling.textContent = daySelected
    ? 'Previstos finais nos registros filtrados'
    : 'Selecione um dia de aplicação';
  $('present').nextElementSibling.textContent = daySelected
    ? 'Presenças registradas na base'
    : 'Selecione um dia de aplicação';
  $('rate').nextElementSibling.textContent = daySelected
    ? 'Presentes ÷ previstos finais'
    : 'Selecione um dia de aplicação';
}

function renderCharts(result) {
  const grades = result.gradeStats.filter(item => isGradeLabel(item.grade));
  const daySelected = Boolean($('day').value);
  $('gradeChartHint').textContent = 'Média da participação por dia de aplicação para cada ano/série';
  $('attendanceChartHint').textContent = daySelected
    ? 'Distribuição dos registros filtrados na data selecionada'
    : 'Selecione um dia de aplicação para visualizar presentes e ausentes';
  const labels = grades.map(item => gradeDisplayLabel(item.grade));
  const participation = grades.map(item =>
    item.participation === null ? null : item.participation * 100
  );
  const maxParticipation = Math.max(100, ...participation);
  const participationColor = value => value === null
    ? '#d6d3d1'
    : value >= 80 ? '#16a34a' : '#dc2626';
  const barColors = participation.map(participationColor);

  if (gradeChart) gradeChart.destroy();
  gradeChart = new Chart($('gradeChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Participação (%)',
        data: participation,
        backgroundColor: barColors,
        borderColor: barColors,
        borderWidth: 1,
        borderRadius: 6,
        maxBarThickness: 48
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          max: maxParticipation > 100 ? maxParticipation * 1.05 : 100,
          ticks: { callback: value => value + '%' }
        },
        x: { grid: { display: false } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: context => context.raw === null
              ? 'Sem dados lançados'
              : `Participação: ${Number(context.raw).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
          }
        }
      }
    }
  });

  if (attendanceChart) attendanceChart.destroy();
  const totals = result.totals;
  attendanceChart = new Chart($('attendanceChart'), {
    type: 'doughnut',
    data: {
      labels: ['Presentes', 'Ausentes'],
      datasets: [{
        data: totals ? [totals.present, totals.absent] : [0, 0],
        backgroundColor: ['#16a34a', '#dc2626'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '67%',
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

function renderTable(rows) {
  tableRows = rows;
  $('downloadSheet').disabled = rows.length === 0;
  $('count').textContent = `${fmt(rows.length)} registros consolidados`;
  if (!rows.length) {
    $('table').innerHTML = '<div class="empty">A planilha não tem dados preenchidos para os filtros selecionados.</div>';
    return;
  }

  if (sheetCsvUrl) {
    const turmaView = $('type').value === 'TURMA' && !isRegionalCsvData();
    const schoolHeading = isRegionalCsvData() ? 'Abrangência' : 'Unidade Escolar';
    $('table').innerHTML = `<table><thead><tr>
      <th class="school-column">${schoolHeading}</th><th>Ano/Série</th>${turmaView ? '<th>Turma</th>' : ''}<th>Período</th><th>Dia de aplicação</th>
      <th>Total Alunos Prev. Inicial</th><th>Total Alunos Transferidos</th>
      <th>Total Alunos Evadidos</th><th>Total Alunos Prev. Final</th>
      <th>Presentes</th><th>Ausentes</th><th>% Participação</th><th>% Ausentes</th>
    </tr></thead><tbody>${rows.slice(0, 1200).map(row => {
      return `<tr>
        <td class="school-column">${esc(row.school)}</td><td>${esc(row.grade || '—')}</td>
        ${turmaView ? `<td>${esc(row.turma || '—')}</td>` : ''}
        <td>${esc(row.period || '—')}</td><td>${esc(row.day || '—')}</td>
        <td>${fmt(row.initial)}</td><td>${fmt(row.transfers)}</td>
        <td>${fmt(row.evaded)}</td><td>${fmt(row.planned)}</td>
        <td>${fmt(row.present)}</td><td>${fmt(row.absent)}</td>
        <td>${participationIndicator(row)}</td>
        <td>${absenceIndicator(row)}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
    return;
  }

  const schoolHeading = sheetCsvUrl && isRegionalCsvData() ? 'Abrangência' : 'Unidade Escolar';
  $('table').innerHTML = `<table><thead><tr>
    <th>Visão</th><th>Ano/Série</th><th class="school-column">${schoolHeading}</th><th>Turma</th>
    <th>Período</th><th>Data</th><th>Previsto inicial</th><th>Transferidos</th>
    <th>Evadidos</th><th>Previsto final</th><th>Presentes</th><th>Ausentes</th>
    <th>Participação</th><th>% Ausentes</th>
  </tr></thead><tbody>${rows.slice(0, 1200).map(row => `<tr>
    <td>${esc(sheetCsvUrl && isRegionalCsvData() ? 'Regional' : row.type === 'ESCOLA' ? 'Escola' : 'Turma')}</td>
    <td>${esc(row.grade || '—')}</td><td class="school-column">${esc(row.school)}</td>
    <td>${esc(row.turma || '—')}</td><td>${esc(row.period || '—')}</td>
    <td>${esc(row.day || '—')}</td><td>${fmt(row.initial)}</td>
    <td>${fmt(row.transfers)}</td><td>${fmt(row.evaded)}</td>
    <td>${fmt(row.planned)}</td><td>${fmt(row.present)}</td>
    <td>${fmt(row.absent)}</td>
    <td>${participationIndicator(row)}</td>
    <td>${absenceIndicator(row)}</td>
  </tr>`).join('')}</tbody></table>`;
}

function csvCell(value) {
  const text = String(value ?? '');
  const safeText = /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
}

function downloadFilteredRows() {
  if (!tableRows.length) return;

  const regionalData = sheetCsvUrl && isRegionalCsvData();
  const schoolHeading = regionalData ? 'Abrangência' : 'Unidade Escolar';
  const turmaView = sheetCsvUrl && $('type').value === 'TURMA' && !regionalData;
  const headers = sheetCsvUrl
    ? [
      schoolHeading, 'Ano/Série', ...(turmaView ? ['Turma'] : []), 'Período',
      'Dia de aplicação', 'Total Alunos Prev. Inicial', 'Total Alunos Transferidos',
      'Total Alunos Evadidos', 'Total Alunos Prev. Final', 'Presentes', 'Ausentes',
      '% Participação', '% Ausentes'
    ]
    : [
      'Visão', 'Ano/Série', schoolHeading, 'Turma', 'Período', 'Data',
      'Previsto inicial', 'Transferidos', 'Evadidos', 'Previsto final',
      'Presentes', 'Ausentes', 'Participação', '% Ausentes'
    ];
  const records = tableRows.map(row => {
    const participation = row.planned ? pct(row.present / row.planned) : '—';
    const absence = row.planned ? pct(row.absent / row.planned) : '—';
    const metrics = [
      fmt(row.initial), fmt(row.transfers), fmt(row.evaded), fmt(row.planned),
      fmt(row.present), fmt(row.absent), participation, absence
    ];
    return sheetCsvUrl
      ? [
        row.school, row.grade || '—', ...(turmaView ? [row.turma || '—'] : []),
        row.period || '—', row.day || '—', ...metrics
      ]
      : [
        regionalData ? 'Regional' : row.type === 'ESCOLA' ? 'Escola' : 'Turma',
        row.grade || '—', row.school, row.turma || '—', row.period || '—',
        row.day || '—', ...metrics
      ];
  });
  const csv = '\uFEFF' + [headers, ...records]
    .map(record => record.map(csvCell).join(';'))
    .join('\r\n');
  const today = new Date();
  const date = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0')
  ].join('-');
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.href = url;
  link.download = `detalhamento-aplicacao-${date}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function absenceIndicator(row) {
  if (!row.planned) {
    return '<span class="absence-status absence-status-na">—</span>';
  }

  const rate = row.absent / row.planned;
  const status = rate < 0.01
    ? 'low'
    : rate <= 0.20 ? 'medium' : 'high';
  const label = status === 'low'
    ? 'Baixa'
    : status === 'medium' ? 'Intermediária' : 'Alta';

  return `<span class="absence-status absence-status-${status}" ` +
    `aria-label="Ausência ${label}: ${pct(rate)}" title="Ausência ${label}">` +
    `<span class="absence-light absence-light-${status}" aria-hidden="true"></span>` +
    `${pct(rate)}</span>`;
}

function participationIndicator(row) {
  if (!row.planned) {
    return '<span class="participation-status participation-status-na">—</span>';
  }

  const rate = row.present / row.planned;
  const status = rate >= 0.8 ? 'high' : 'low';
  const label = status === 'high' ? 'Alta' : 'Baixa';

  return `<span class="participation-status participation-status-${status}" ` +
    `aria-label="Participação ${label}: ${pct(rate)}" title="Participação ${label}">` +
    `<span class="participation-light participation-light-${status}" aria-hidden="true"></span>` +
    `${pct(rate)}</span>`;
}

// Busca, validação e estado da conexão com as fontes de dados.
async function render() {
  const requestId = ++dashboardRequest;
  updatePrintSummary();
  const query = new URLSearchParams(currentFilters());
  try {
    const result = sheetCsvUrl
      ? aggregatePublishedData(data, $('type').value, currentFilters())
      : await requestJson('/api/dashboard?' + query.toString());
    if (requestId !== dashboardRequest) return;
    setMetrics(result);
    renderCharts(result);
    renderTable(result.rows);
    showQualityNotice(result.quality, result);
  } catch (error) {
    if (requestId !== dashboardRequest) return;
    showNotice(error.message, true);
    tableRows = [];
    $('downloadSheet').disabled = true;
    $('table').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function applyData(result) {
  if (!Array.isArray(result.rows)) {
    throw new Error('A resposta do servidor não contém uma lista de escolas/turmas.');
  }
  data = result.rows;
  availableSchools = Array.isArray(result.schools)
    ? result.schools
    : uniq(data.filter(row => row.type === 'TURMA').map(row => row.school));
  availableGrades = sortGrades([
    ...additionalGrades,
    ...(result.grades || []),
    ...data.map(row => row.grade)
  ].filter(isGradeLabel));
  isConnected = true;
  fill('grade', availableGrades, 'Todas');
  const regionalOnly = isRegionalCsvData();
  fill(
    'school',
    regionalOnly ? [] : availableSchools,
    regionalOnly ? 'Dados regionais (sem unidade)' : 'Todas as unidades'
  );
  $('schoolHint').textContent = regionalOnly
    ? 'A fonte atual contém totais regionais; selecione uma fonte com dados por unidade para filtrar escolas.'
    : 'Filtre os indicadores pelos dados da unidade selecionada.';
  availableDates = Array.isArray(result.dates) && result.dates.length
    ? result.dates
    : uniq(data.filter(row => row.type === 'TURMA').map(row => row.day));
  availableDates = uniq([
    ...availableDates,
    ...Object.values(applicationSchedule).flat()
  ]).sort((left, right) =>
    Date.UTC(...left.split('/').reverse().map(Number)) -
    Date.UTC(...right.split('/').reverse().map(Number))
  );
  fillAvailableDays();
  fillTurmas();
  render();
  $('login').hidden = true;
  $('logout').hidden = Boolean(sheetCsvUrl);
  $('refresh').disabled = false;
  $('status').textContent = sheetCsvUrl ? 'Sincronizado com Google Sheets' : 'Conectado ao SharePoint';
  $('stamp').textContent = 'Atualizado: ' + new Date(result.updatedAt).toLocaleString('pt-BR');
  $('sourceInfo').textContent = sheetCsvUrl
    ? `${fmt(data.length)} registros agregados · fonte: Google Sheets`
    : fmt(data.length) + ' registros carregados · consolidação pelas turmas';
  showNotice(data.length
    ? sheetCsvUrl
      ? `Planilha Google sincronizada. Dados agregados ${isRegionalCsvData() ? 'por série e dia' : 'por escola, série e dia'}; filtros e gráficos atualizados.`
      : 'Planilha conectada. Totais consolidados a partir das abas de turma; filtros aplicados antes dos cálculos.'
    : 'Planilha acessada, mas não encontrei escolas nas abas de aplicação.', !data.length);
}

async function loadData() {
  try {
    $('refresh').disabled = true;
    $('status').textContent = 'Sincronizando...';
    applyData(sheetCsvUrl ? await loadPublishedSheet() : await requestJson('/api/data'));
  } catch (error) {
    $('status').textContent = 'Falha na conexão';
    showNotice(error.message, true);
    $('table').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  } finally {
    $('refresh').disabled = !isConnected;
  }
}

async function check() {
  if (sheetCsvUrl) {
    $('login').textContent = '🔄 Sincronizar planilha Google';
    $('login').hidden = false;
    $('logout').hidden = true;
    document.querySelector('label[for="school"]').textContent = 'Unidade Escolar';
    await loadData();
    return;
  }
  try {
    const status = await requestJson('/api/status');
    isConnected = Boolean(status.connected);
    $('login').hidden = isConnected;
    $('logout').hidden = !isConnected;
    $('refresh').disabled = !isConnected;
    $('login').disabled = false;
        $('login').textContent = '🔗 Conectar e carregar a planilha';
    if (isConnected) {
      await loadData();
    } else {
      $('status').textContent = status.configured ? 'Desconectado' : 'Servidor indisponível';
      if (status.error) showNotice(status.error, true);
    }
  } catch (error) {
    isConnected = false;
    $('status').textContent = 'Servidor indisponível';
    $('login').disabled = false;
    $('refresh').disabled = true;
    showNotice(error.message, true);
  }
}

async function startLogin() {
  if (sheetCsvUrl) {
    await loadData();
    return;
  }
  try {
    $('login').disabled = true;
    $('status').textContent = 'Acessando SharePoint...';
    showNotice('Aguardando leitura da planilha com o acesso institucional deste Windows.');
    applyData(await requestJson('/auth/login', { method: 'POST' }));
  } catch (error) {
    $('status').textContent = 'Falha ao conectar';
    showNotice(error.message, true);
  } finally {
    $('login').disabled = false;
  }
}

async function disconnect() {
  try {
    await requestJson('/auth/logout', { method: 'POST' });
    data = [];
    availableSchools = [];
    availableGrades = [];
    availableDates = [];
    isConnected = false;
    fill('grade', [], 'Todas');
    fill('school', [], 'Todas');
    fill('day', [], 'Todos');
    fill('turma', [], 'Todas');
    renderTable([]);
    setMetrics({ totals: null });
    if (gradeChart) gradeChart.destroy();
    if (attendanceChart) attendanceChart.destroy();
    gradeChart = null;
    attendanceChart = null;
    $('login').hidden = false;
    $('logout').hidden = true;
    $('refresh').disabled = true;
    $('status').textContent = 'Desconectado';
    $('stamp').textContent = 'Fonte: SharePoint institucional';
    $('sourceInfo').textContent = 'Base: planilha institucional do SharePoint';
    showNotice('Painel desconectado. Clique em “Conectar e carregar a planilha” para buscar os dados novamente.');
  } catch (error) {
    showNotice(error.message, true);
  }
}

// Eventos dos controles do painel e atualização automática.
$('login').onclick = startLogin;
$('refresh').onclick = loadData;
$('logout').onclick = disconnect;
['grade', 'school', 'day', 'turma', 'type'].forEach(id => {
  const element = $(id);
  if (!element) return;
  element.addEventListener('change', () => {
    if (id === 'grade') {
      fillAvailableDays();
      syncItinerarioFilter(id);
    }
    if (id === 'day') {
      syncItinerarioFilter(id);
      fillAvailableDays();
    }
    if (id === 'grade' || id === 'school') fillTurmas();
    render();
  });
});
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 150);
});
$('downloadPdf').addEventListener('click', () => {
  updatePrintSummary();
  window.print();
});
$('downloadSheet').addEventListener('click', downloadFilteredRows);

check();
setInterval(async () => {
  if (sheetCsvUrl) {
    await loadData();
    return;
  }
  try {
    const status = await requestJson('/api/status');
    if (status.connected) await loadData();
  } catch (error) {
    $('status').textContent = 'Falha na conexão';
    showNotice(error.message, true);
  }
}, 60000);
