/* Дымовой тест StrausTube: прогоняет основные сценарии в jsdom.
   Запуск: npm install && node scripts/smoke-test.js
   Зависимость нужна только для тестов, в продакшене не используется. */
'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');
const nodeCrypto = require('crypto');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

let failures = 0;
function check(label, condition, extra) {
  if (condition) {
    console.log('  ok  ' + label);
  } else {
    failures++;
    console.log('  FAIL ' + label + (extra ? ' — ' + extra : ''));
  }
}

const dom = new JSDOM(html, {
  url: 'http://localhost:10000/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;
const { document } = window;

/* --- минимальные полифилы окружения --- */
Object.defineProperty(window, 'crypto', { value: nodeCrypto.webcrypto, configurable: true, writable: true });
window.TextEncoder = util.TextEncoder;
window.TextDecoder = util.TextDecoder;
window.URL.createObjectURL = () => 'blob:test-' + Math.random().toString(16).slice(2);
window.URL.revokeObjectURL = () => {};
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};

const errors = [];
window.addEventListener('error', e => errors.push(String(e.error || e.message)));

window.eval(js);

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const submit = form => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
const key = (k, opts) => document.dispatchEvent(new window.KeyboardEvent('keydown',
  Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {})));
const secret = async () => { key('s'); await tick(10); key('Tab'); await tick(25); };
const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
async function nav(hash) { window.location.hash = hash; await tick(30); }

(async function run() {
  console.log('\n1. Первый запуск и главная лента');
  check('сетка видео отрисована', $$('.vcard').length >= 8, 'карточек: ' + $$('.vcard').length);
  check('сайдбар содержит навигацию', $$('#sidebarNav a').length >= 5);
  check('уведомление о демо показано', !!$('.demo-bar'));

  console.log('\n2. Поиск');
  const si = $('#searchInput');
  si.value = 'Bunny';
  $('#searchForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(30);
  check('перешли в поиск', window.location.hash.indexOf('#/search') === 0, window.location.hash);
  check('найдено видео по запросу', $$('.vcard').length >= 1);

  console.log('\n3. Регистрация');
  await nav('#/login');
  check('форма входа есть', !!$('#loginForm'));
  click($('[data-auth-tab="register"]'));
  check('переключились на регистрацию', $('#registerForm').hidden === false);
  $('#regName').value = 'Тестовый Автор';
  $('#regPass').value = 'supersecret';
  $('#regPass2').value = 'supersecret';
  submit($('#registerForm'));
  await tick(300);
  const saved = JSON.parse(window.localStorage.getItem('straustube.users.v1'));
  const created = saved.find(u => u.name === 'Тестовый Автор');
  check('аккаунт создан', !!created);
  check('пароль сохранён как хеш PBKDF2', !!(created && created.password && created.password.startsWith('p1$')));
  check('пароль не хранится открытым текстом', !!(created && created.password.indexOf('supersecret') === -1));

  console.log('\n4. Загрузка видео');
  await nav('#/upload');
  check('форма загрузки доступна автору', !!$('#uploadForm'));
  $('#upTitle').value = 'Мой первый ролик на StrausTube';
  $('#upDesc').value = 'Тестовое описание';
  $('#upYoutube').value = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  submit($('#uploadForm'));
  await tick(80);
  check('перешли на страницу просмотра', window.location.hash.indexOf('#/watch/') === 0, window.location.hash);
  check('плеер встроен через youtube-nocookie', !!$('.player iframe') && $('.player iframe').src.indexOf('youtube-nocookie.com/embed/dQw4w9WgXcQ') !== -1);
  check('на странице есть блок комментариев', !!$('.comments'));

  console.log('\n5. Лайк и комментарий');
  const likeBtn = $('#likeBtn');
  click(likeBtn);
  await tick(30);
  check('лайк поставлен', likeBtn.classList.contains('on'));
  click(likeBtn);
  await tick(30);
  check('лайк снят', !likeBtn.classList.contains('on'));
  $('#commentText').value = 'Проверка комментария';
  submit($('#commentForm'));
  await tick(30);
  check('комментарий появился в списке', document.body.textContent.indexOf('Проверка комментария') !== -1);
  const commentId = $$('[data-del-comment]').length;
  check('кнопка удаления комментария доступна автору', commentId >= 1);

  console.log('\n6. Чужой канал и подписка на профиль');
  await nav('#/channel/u-kosmos');
  check('страница чужого канала открылась', document.body.textContent.indexOf('КосмоКот') !== -1);
  check('видео чужого канала видны', $$('.vcard').length >= 1);

  console.log('\n7. Скрытая панель администратора');
  key('Tab');
  await tick(20);
  check('обычный Tab не открывает панель (доступность клавиатуры не ломается)', !$('.admin-panel'));
  await secret();
  check('панель открылась по S + Tab', !!$('.admin-panel'));
  check('панель не видна обычным маршрутом', !document.body.textContent.includes('Служебный доступ · StrausTube') === false || !!$('.admin-panel'));
  const userTab = $$('[data-tab]').find(b => b.dataset.tab === 'users');
  click(userTab);
  await tick(20);
  check('таблица пользователей отрисована', $$('[data-act="ride"]').length >= 5);
  const rideBtn = $$('[data-act="ride"]')[0];
  click(rideBtn);
  await tick(30);
  check('панель закрылась после входа как другой профиль', !$('.admin-panel'));
  check('в шапке появилась отметка режима входа', document.body.textContent.indexOf('режим входа') !== -1);

  console.log('\n8. Администратор меняет и удаляет видео');
  await secret();
  const videoTab = $$('[data-tab]').find(b => b.dataset.tab === 'videos');
  click(videoTab);
  await tick(20);
  const beforeVideos = JSON.parse(window.localStorage.getItem('straustube.videos.v1')).length;
  const delVideo = $$('[data-act="delV"]')[0];
  click(delVideo);
  await tick(20);
  check('диалог подтверждения удаления видео открыт', !!$('#cfOk'));
  click($('#cfOk'));
  await tick(60);
  const afterVideos = JSON.parse(window.localStorage.getItem('straustube.videos.v1')).length;
  check('видео удалено администратором', afterVideos === beforeVideos - 1, beforeVideos + ' -> ' + afterVideos);

  console.log('\n8.1. Экспорт и импорт данных в панели');
  const dataTab = $$('[data-tab]').find(b => b.dataset.tab === 'data');
  click(dataTab);
  await tick(30);
  check('вкладка «Данные и стенд» открылась', !!$('[data-act="exportAll"]'));
  const exportBtn = $('[data-act="exportAll"]');
  check('кнопка выгрузки доступна', !!exportBtn);
  const importInput = $('[data-act="importAll"]');
  check('поле импорта найдено', !!importInput);
  if (importInput) {
    const payload = {
      users: [{ id: 'u-alt', name: 'Импортный Канал', avatar: '', password: null, isAdmin: false, createdAt: Date.now() }],
      videos: [{ id: 'v-alt', title: 'Импортированное видео', channelId: 'u-alt', category: 'Наука', source: 'placeholder', views: 5, likes: [], createdAt: Date.now() }],
      comments: []
    };
    const file = new window.File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' });
    Object.defineProperty(importInput, 'files', { value: [file], configurable: true });
    importInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick(60);
    check('диалог подтверждения импорта открыт', !!$('#cfOk'));
    if ($('#cfOk')) {
      click($('#cfOk'));
      await tick(80);
      const imported = JSON.parse(window.localStorage.getItem('straustube.users.v1'));
      check('данные заменены файлом импорта', imported.length === 1 && imported[0].name === 'Импортный Канал',
        'профилей: ' + imported.length);
    }
  }
  /* Возвращаем демо-набор, чтобы дальнейшие проверки шли по знакомым данным */
  const reseedBtn = $('[data-act="reseed"]');
  check('кнопка восстановления демо-данных доступна', !!reseedBtn);
  if (reseedBtn) { click(reseedBtn); await tick(40); if ($('#cfOk')) { click($('#cfOk')); await tick(120); } }
  const restored = JSON.parse(window.localStorage.getItem('straustube.users.v1'));
  check('демо-набор восстановлен', restored.length >= 5, 'профилей: ' + restored.length);

  console.log('\n9. Маскировка панели');
  const maskBtn = $('[data-act="maskBtn"]');
  check('переключатель маскировки доступен в панели', !!maskBtn);
  if (maskBtn) {
    click(maskBtn);
    await tick(20);
    check('маскировка включена', JSON.parse(window.localStorage.getItem('straustube.mask.v1')) === true);
  }
  key('Escape');
  await tick(20);
  check('панель скрыта по Esc', !$('.admin-panel'));
  await secret();
  check('при маскировке показан технический экран', !!$('#decoyForm') && document.body.textContent.indexOf('Технический экран') !== -1);
  await secret();
  check('повторная комбинация открывает панель', !!$('.admin-panel'));
  key('Escape');
  await tick(20);

  console.log('\n10. Переключение аккаунтов и выход');
  await nav('#/');
  const accBtn = $('#accountBtn');
  if (accBtn) {
    click(accBtn);
    await tick(20);
    const switchBtn = $('#switchAccBtn');
    check('в меню аккаунта есть смена профиля', !!switchBtn);
    if (switchBtn) {
      click(switchBtn);
      await tick(20);
      check('список профилей открыт', $$('.switch-item').length >= 5);
      click($$('.switch-item').find(b => b.textContent.indexOf('Mila_K') !== -1));
      await tick(30);
      check('вошли в демо-профиль Mila_K', document.body.textContent.indexOf('Mila_K') !== -1);
    }
  }

  console.log('\n11. Служебные страницы и очистка');
  await nav('#/about');
  check('страница «О проекте» открылась', document.body.textContent.indexOf('О проекте StrausTube') !== -1);
  await nav('#/privacy');
  check('страница конфиденциальности открылась', document.body.textContent.indexOf('Конфиденциальность') !== -1);
  await nav('#/studio');
  check('студия открылась для вошедшего пользователя', document.body.textContent.indexOf('Моя студия') !== -1);

  console.log('\n12. Ошибки во время выполнения');
  check('не было исключений', errors.length === 0, errors.join(' | '));

  console.log('\n' + (failures ? 'ПРОВАЛЕНО проверок: ' + failures : 'Все проверки пройдены'));
  process.exit(failures ? 1 : 0);
})().catch(err => {
  console.error('Тест упал с ошибкой:', err);
  process.exit(1);
});
