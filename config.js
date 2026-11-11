window.PAINEL_API_URL = '';
const sheetCsvBaseUrl = 'https://docs.google.com/spreadsheets/d/1QfzNlc-BONpnbFUye1I3jUxH5gpIuVsN/export?format=csv&gid=';
// Abas consolidadas por escola, separadas por ano/série.
window.PAINEL_SHEET_CSV_URLS = [
  { url: sheetCsvBaseUrl + '1604984207', grade: '6º', view: 'ESCOLA' },
  { url: sheetCsvBaseUrl + '407934044', grade: '7º', view: 'ESCOLA' },
  { url: sheetCsvBaseUrl + '1800324235', grade: '8º', view: 'ESCOLA' },
  { url: sheetCsvBaseUrl + '1950903520', grade: '9º', view: 'ESCOLA' },
  { url: sheetCsvBaseUrl + '1901238714', grade: '1ª', view: 'ESCOLA' },
  { url: sheetCsvBaseUrl + '511519591', grade: '2ª', view: 'ESCOLA' },
  { url: sheetCsvBaseUrl + '1756749988', grade: '3º', view: 'ESCOLA' },
  { url: sheetCsvBaseUrl + '1667717828', grade: '3ª Itinerário', view: 'ESCOLA' },
  { url: sheetCsvBaseUrl + '304431440', grade: '2ª Itinerário', view: 'ESCOLA' },
  // Abas detalhadas por turma, para as opções da visualização por turma.
  { url: sheetCsvBaseUrl + '523389416', grade: '6º', view: 'TURMA' },
  { url: sheetCsvBaseUrl + '1600936784', grade: '7º', view: 'TURMA' },
  { url: sheetCsvBaseUrl + '1550616383', grade: '8º', view: 'TURMA' },
  { url: sheetCsvBaseUrl + '2105700601', grade: '9º', view: 'TURMA' },
  { url: sheetCsvBaseUrl + '528212905', grade: '1ª', view: 'TURMA' },
  { url: sheetCsvBaseUrl + '1948635231', grade: '2ª', view: 'TURMA' },
  { url: sheetCsvBaseUrl + '412744844', grade: '3º', view: 'TURMA' },
  { url: sheetCsvBaseUrl + '456843553', grade: '2ª Itinerário', view: 'TURMA' },
  { url: sheetCsvBaseUrl + '1976129642', grade: '3ª Itinerário', view: 'TURMA' }
];
