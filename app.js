(() => {
  'use strict';

  const LOCATIONS = Array.isArray(window.LOCATIONS) ? window.LOCATIONS : [];
  const THEMES = Array.isArray(window.LOCATION_THEMES) ? window.LOCATION_THEMES : [];
  const ADULT_THEMES = new Set(THEMES.filter((t) => t.adult).map((t) => t.id));
  const STORE_KEY = 'shpion.v1';
  const MIN_PLAYERS = 3;
  const MAX_PLAYERS = 12;
  const TWO_SPIES_FROM = 5;
  const MIN_MINUTES = 3;
  const MAX_MINUTES = 15;
  const NAME_MAX = 16;
  const CONFIRM_MS = 3000;

  const app = document.getElementById('app');

  // ===== Хранилище (игра работает и без него) =====
  const store = {
    load() {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },
    save(data) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(data));
      } catch (e) { /* приватный режим или запрет — играем без сохранения */ }
    }
  };

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  const saved = store.load() || {};
  const settings = {
    players: clamp(parseInt(saved.players, 10) || 5, MIN_PLAYERS, MAX_PLAYERS),
    spies: saved.spies === 2 ? 2 : 1,
    minutes: clamp(parseInt(saved.minutes, 10) || 8, MIN_MINUTES, MAX_MINUTES),
    names: Array.isArray(saved.names)
      ? saved.names.slice(0, MAX_PLAYERS).map((n) => String(n == null ? '' : n).slice(0, NAME_MAX))
      : [],
    music: saved.music !== false,
    // Пустой список — «Все локации» (без тем 18+)
    themes: Array.isArray(saved.themes) ? THEMES.filter((t) => saved.themes.includes(t.id)).map((t) => t.id) : []
  };
  let lastLocation = typeof saved.lastLocation === 'string' ? saved.lastLocation : null;
  normalizeSpies();

  function normalizeSpies() {
    if (settings.players < TWO_SPIES_FROM) settings.spies = 1;
  }

  function persist() {
    store.save({
      players: settings.players,
      spies: settings.spies,
      minutes: settings.minutes,
      names: settings.names,
      music: settings.music,
      themes: settings.themes,
      lastLocation
    });
  }

  function locationPool(themes = settings.themes) {
    const themesOf = (l) => (Array.isArray(l.themes) ? l.themes : []);
    // Локации 18+ попадают в игру, только если тема 18+ выбрана явно
    const adultOn = themes.some((id) => ADULT_THEMES.has(id));
    return LOCATIONS.filter((l) => {
      const ts = themesOf(l);
      if (!adultOn && ts.some((id) => ADULT_THEMES.has(id))) return false;
      return !themes.length || ts.some((id) => themes.includes(id));
    });
  }

  function pluralLocations(n) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return `${n} локация`;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} локации`;
    return `${n} локаций`;
  }

  function playerName(i) {
    const n = (settings.names[i] || '').trim();
    return n || `Игрок ${i + 1}`;
  }

  // ===== Случайность =====
  function randInt(n) {
    try {
      const limit = Math.floor(0x100000000 / n) * n;
      const buf = new Uint32Array(1);
      do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
      return buf[0] % n;
    } catch (e) {
      return Math.floor(Math.random() * n);
    }
  }

  // Фишер–Йетс
  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ===== DOM-хелпер =====
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // Таймауты текущего экрана — сбрасываются при смене экрана
  const screenTimeouts = new Set();
  function later(fn, ms) {
    const id = setTimeout(() => { screenTimeouts.delete(id); fn(); }, ms);
    screenTimeouts.add(id);
    return id;
  }

  function mount(screen) {
    screenTimeouts.forEach(clearTimeout);
    screenTimeouts.clear();
    app.replaceChildren(screen);
    window.scrollTo(0, 0);
  }

  function screen(bodyClass, body, bar, fit) {
    return h('section', { class: fit ? 'screen screen--fit' : 'screen' },
      h('div', { class: `screen__body ${bodyClass || ''}`.trim() }, body),
      bar ? h('div', { class: 'bar' }, bar) : null
    );
  }

  // Кнопка с подтверждением вторым нажатием в течение 3 секунд
  function confirmButton(label, armedLabel, className, onConfirm) {
    let armed = false;
    let timeoutId = null;
    const btn = h('button', { type: 'button', class: className, text: label });
    const disarm = () => {
      armed = false;
      btn.textContent = label;
      btn.classList.remove('btn--armed');
    };
    btn.addEventListener('click', () => {
      if (armed) {
        clearTimeout(timeoutId);
        screenTimeouts.delete(timeoutId);
        disarm();
        onConfirm();
        return;
      }
      armed = true;
      btn.textContent = armedLabel;
      btn.classList.add('btn--armed');
      timeoutId = later(disarm, CONFIRM_MS);
    });
    return btn;
  }

  // ===== Игра =====
  let game = null;

  function deal() {
    const n = settings.players;
    const all = locationPool();
    const pool = all.length > 1 ? all.filter((l) => l.name !== lastLocation) : all;
    const location = pool[randInt(pool.length)];
    lastLocation = location.name;
    persist();

    const spyIdx = new Set(shuffle([...Array(n).keys()]).slice(0, settings.spies));
    const roles = shuffle(location.roles);
    let r = 0;
    const players = [];
    for (let i = 0; i < n; i++) {
      const spy = spyIdx.has(i);
      players.push({ name: playerName(i), spy, role: spy ? null : roles[r++ % roles.length] });
    }

    game = {
      location: location.name,
      pool: all.map((l) => l.name).sort((a, b) => a.localeCompare(b, 'ru')),
      players,
      index: 0,
      firstAsker: players[randInt(n)].name,
      crossed: new Set(),
      timer: { status: 'idle', endAt: 0, remaining: settings.minutes * 60 * 1000 }
    };
  }

  // ===== Экран 1: настройки =====
  function stepper(label, hint, get, min, max, onChange) {
    const value = h('span', { class: 'stepper__value', 'aria-live': 'polite' });
    const minus = h('button', { type: 'button', class: 'stepper__btn', 'aria-label': `${label}: меньше`, text: '−' });
    const plus = h('button', { type: 'button', class: 'stepper__btn', 'aria-label': `${label}: больше`, text: '+' });
    const sync = () => {
      const v = get();
      value.textContent = v;
      minus.disabled = v <= min;
      plus.disabled = v >= max;
    };
    minus.addEventListener('click', () => { onChange(clamp(get() - 1, min, max)); sync(); });
    plus.addEventListener('click', () => { onChange(clamp(get() + 1, min, max)); sync(); });
    sync();
    return h('div', { class: 'row' },
      h('span', { class: 'row__label' }, label, hint ? h('span', { class: 'row__hint', text: hint }) : null),
      h('div', { class: 'stepper' }, minus, value, plus)
    );
  }

  function renderSettings() {
    stopRound();

    const names = h('div', { class: 'names' });
    const fillNames = () => {
      const fields = [];
      for (let i = 0; i < settings.players; i++) {
        const input = h('input', {
          type: 'text',
          maxlength: NAME_MAX,
          placeholder: `Игрок ${i + 1}`,
          autocomplete: 'off',
          autocapitalize: 'words',
          spellcheck: 'false',
          enterkeyhint: i < settings.players - 1 ? 'next' : 'done',
          'aria-label': `Имя игрока ${i + 1}`
        });
        input.value = settings.names[i] || '';
        input.addEventListener('input', () => {
          if (input.value.length > NAME_MAX) input.value = input.value.slice(0, NAME_MAX);
          settings.names[i] = input.value;
          persist();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const next = names.querySelectorAll('input')[i + 1];
          if (next) next.focus(); else input.blur();
        });
        fields.push(h('label', { class: 'name-field' },
          h('span', { class: 'name-field__num', text: String(i + 1).padStart(2, '0') }),
          input
        ));
      }
      names.replaceChildren(...fields);
    };

    const spyBtns = [1, 2].map((n) => h('button', {
      type: 'button', class: 'segmented__btn', text: n, 'aria-label': `Шпионов: ${n}`
    }));
    const spyHint = h('span', { class: 'row__hint' });
    const syncSpies = () => {
      normalizeSpies();
      spyBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(settings.spies === i + 1)));
      spyBtns[1].disabled = settings.players < TWO_SPIES_FROM;
      spyHint.textContent = settings.players < TWO_SPIES_FROM ? `Второй — от ${TWO_SPIES_FROM} игроков` : 'Шпионы не знают друг друга';
    };
    spyBtns.forEach((b, i) => b.addEventListener('click', () => {
      settings.spies = i + 1;
      syncSpies();
      persist();
    }));

    // Темы локаций: большая кнопка «Все локации» и темы с мультивыбором
    const themeAll = h('button', { type: 'button', class: 'theme-all' },
      h('span', { class: 'theme-all__title', text: 'Все локации' }),
      h('span', { class: 'theme-all__count' },
        pluralLocations(locationPool([]).length),
        ADULT_THEMES.size ? [h('br'), 'без 18+'] : null)
    );
    themeAll.addEventListener('click', () => {
      settings.themes = [];
      syncThemes();
      persist();
    });
    const themeChips = THEMES.map((t) => {
      const chip = h('button', { type: 'button', class: t.adult ? 'theme-chip theme-chip--adult' : 'theme-chip' },
        h('span', { class: 'theme-chip__name', text: t.name }),
        h('span', { class: 'theme-chip__count', text: locationPool([t.id]).length })
      );
      chip.addEventListener('click', () => {
        const selected = new Set(settings.themes);
        if (selected.has(t.id)) selected.delete(t.id); else selected.add(t.id);
        settings.themes = THEMES.filter((x) => selected.has(x.id)).map((x) => x.id);
        syncThemes();
        persist();
      });
      return { id: t.id, chip };
    });
    const poolNote = h('p', { class: 'theme-note', 'aria-live': 'polite' });
    const syncThemes = () => {
      themeAll.setAttribute('aria-pressed', String(settings.themes.length === 0));
      themeChips.forEach(({ id, chip }) => chip.setAttribute('aria-pressed', String(settings.themes.includes(id))));
      poolNote.textContent = settings.themes.length
        ? `В игре ${pluralLocations(locationPool().length)}`
        : 'Можно выбрать одну тему или несколько';
    };

    fillNames();
    syncSpies();
    syncThemes();

    const body = [
      h('header', { class: 'masthead' },
        h('div', { class: 'masthead__file' },
          h('span', { text: 'Дело № 07' }), h('span', { text: 'Для служебного пользования' })),
        h('h1', { class: 'masthead__title', text: 'Шпион' }),
        h('span', { class: 'stamp', 'aria-hidden': 'true' }, 'Совершенно', h('br'), 'секретно'),
        h('p', { class: 'masthead__lead', text: 'Все знают, где вы. Кроме одного. Найдите его, пока он не догадался.' })
      ),
      h('section', { class: 'themes', 'aria-label': 'Темы локаций' },
        h('h2', { class: 'kicker section-title', text: 'Темы локаций' }),
        themeAll,
        h('div', { class: 'theme-grid' }, themeChips.map((c) => c.chip)),
        poolNote
      ),
      h('div', { class: 'panel' },
        stepper('Игроков', null, () => settings.players, MIN_PLAYERS, MAX_PLAYERS, (v) => {
          settings.players = v;
          fillNames();
          syncSpies();
          persist();
        }),
        h('div', { class: 'row' },
          h('span', { class: 'row__label' }, 'Шпионов', spyHint),
          h('div', { class: 'segmented', role: 'group', 'aria-label': 'Количество шпионов' }, spyBtns)
        ),
        stepper('Минут на раунд', null, () => settings.minutes, MIN_MINUTES, MAX_MINUTES, (v) => {
          settings.minutes = v;
          persist();
        })
      ),
      h('h2', { class: 'kicker section-title', text: 'Имена · необязательно' }),
      names,
      h('details', { class: 'rules' },
        h('summary', { text: 'Как играть' }),
        h('ol', null,
          h('li', { text: 'Все, кроме шпиона, получают одну и ту же локацию и свою роль в ней. Шпион не знает ничего.' }),
          h('li', { text: 'Игроки по очереди задают друг другу вопросы о локации — так, чтобы свои поняли, а шпион нет.' }),
          h('li', { text: 'Ответивший задаёт следующий вопрос кому угодно, кроме того, кто только что спрашивал его.' }),
          h('li', { text: 'Шпион может в любой момент раскрыться и назвать локацию: угадал — он победил.' }),
          h('li', { text: 'Когда время выйдет (или раньше), голосуйте, кто шпион. Поймали — победа мирных, ошиблись — победа шпиона.' })
        )
      )
    ];

    const start = h('button', { type: 'button', class: 'btn btn--primary', text: 'Раздать карты' });
    start.addEventListener('click', () => {
      persist();
      deal();
      renderPass();
    });

    mount(screen('', body, start));
  }

  // ===== Экран 2: передача телефона =====
  function progressDots() {
    return h('div', { class: 'dots', 'aria-hidden': 'true' },
      game.players.map((_, i) => h('span', { class: i < game.index ? 'done' : i === game.index ? 'now' : '' })));
  }

  function renderPass() {
    const p = game.players[game.index];
    const total = game.players.length;

    const cancel = confirmButton('← Настройки', 'Отменить раздачу?', 'btn btn--ghost', renderSettings);

    const body = [
      h('div', { class: 'topbar' }, cancel),
      h('div', { class: 'pass' },
        h('p', { class: 'kicker', text: 'Передай телефон' }),
        h('h1', { class: 'title pass__name', text: p.name }),
        h('p', { class: 'pass__count', text: `Карта ${game.index + 1} из ${total}` }),
        progressDots(),
        h('div', { class: 'card card--closed', 'aria-hidden': 'true' },
          h('div', { class: 'card__meta' }, h('span', { text: 'Личное дело' }), h('span', { text: `№ ${String(game.index + 1).padStart(2, '0')}` })),
          h('div', { class: 'card__center' }, h('span', { class: 'stamp' }, 'Совершенно', h('br'), 'секретно')),
          h('div', { class: 'card__meta' }, h('span', { text: 'Вскрыть лично' }))
        )
      )
    ];

    const show = h('button', { type: 'button', class: 'btn btn--primary', text: `Я ${p.name} · показать карту` });
    show.addEventListener('click', renderCard);

    mount(screen('', body, show, true));
  }

  // ===== Экран 3: карта игрока =====
  function renderCard() {
    const p = game.players[game.index];
    const isLast = game.index === game.players.length - 1;
    const num = String(game.index + 1).padStart(2, '0');

    const card = p.spy
      ? h('article', { class: 'card card--spy' },
          h('div', { class: 'card__meta' }, h('span', { text: p.name }), h('span', { text: `№ ${num}` })),
          h('div', { class: 'card__sheet' },
            h('p', { class: 'card__label', text: 'Твоё задание' }),
            h('h2', { class: 'card__value', text: 'Ты шпион' }),
            h('p', { class: 'card__hint', text: 'Локацию ты не знаешь. Слушай вопросы, отвечай уверенно и попробуй догадаться, где все находятся.' })
          ),
          h('div', { class: 'card__stamp-row' }, h('span', { class: 'stamp', text: 'Никому не показывать' }))
        )
      : h('article', { class: 'card' },
          h('div', { class: 'card__meta' }, h('span', { text: p.name }), h('span', { text: `№ ${num}` })),
          h('div', { class: 'card__sheet' },
            h('p', { class: 'card__label', text: 'Локация' }),
            h('h2', { class: 'card__value', text: game.location }),
            h('p', { class: 'card__label', text: 'Твоя роль' }),
            h('p', { class: 'card__value card__value--role', text: p.role })
          ),
          h('div', { class: 'card__stamp-row' }, h('span', { class: 'stamp', text: 'Никому не показывать' }))
        );

    const body = [
      h('p', { class: 'kicker', text: `Карта ${game.index + 1} из ${game.players.length}` }),
      card
    ];

    const hide = h('button', {
      type: 'button',
      class: 'btn btn--ink',
      text: isLast ? 'Спрятать и начать игру' : 'Спрятать и передать дальше'
    });
    hide.addEventListener('click', () => {
      game.index++;
      // mount() заменяет экран целиком — содержимое карты удаляется из DOM
      if (game.index < game.players.length) renderPass();
      else renderRound();
    });

    mount(screen('screen__body--center', body, hide, true));
  }

  // ===== Экран 4: раунд =====
  let tickId = null;
  let wakeLock = null;
  let audioCtx = null;
  let roundUI = null;

  function formatTime(ms) {
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function remainingMs() {
    const t = game.timer;
    return t.status === 'running' ? Math.max(0, t.endAt - Date.now()) : t.remaining;
  }

  async function requestWakeLock() {
    try {
      if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
      const lock = await navigator.wakeLock.request('screen');
      if (!game || game.timer.status !== 'running') { lock.release().catch(() => {}); return; }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    } catch (e) { /* отказ — не страшно */ }
  }

  function releaseWakeLock() {
    const lock = wakeLock;
    wakeLock = null;
    if (lock) lock.release().catch(() => {});
  }

  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      // iOS 17+: иначе Web Audio молчит при включённом беззвучном режиме
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      // Тихий звук в момент нажатия «разблокирует» звук на iOS
      const src = audioCtx.createBufferSource();
      src.buffer = audioCtx.createBuffer(1, 1, 22050);
      src.connect(audioCtx.destination);
      src.start(0);
    } catch (e) { /* без звука */ }
  }

  function beepThreeTimes() {
    try {
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const start = audioCtx.currentTime + 0.05;
      for (let i = 0; i < 3; i++) {
        const t = start + i * 0.32;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.2);
      }
    } catch (e) { /* без звука */ }
  }

  // Safari на iPhone не поддерживает navigator.vibrate, но с iOS 18 переключатель
  // <input type="checkbox" switch> даёт короткий тактильный щелчок — используем его как запасной вариант.
  let hapticLabel = null;
  function hapticTap() {
    try {
      if (!hapticLabel) {
        const input = h('input', { type: 'checkbox', switch: true, tabindex: '-1' });
        hapticLabel = h('label', { class: 'visually-hidden', 'aria-hidden': 'true' }, input);
        document.body.append(hapticLabel);
      }
      hapticLabel.click();
    } catch (e) { /* без отклика */ }
  }

  function vibrate() {
    try {
      if (navigator.vibrate) {
        navigator.vibrate([500, 150, 500, 150, 500, 150, 900]);
        return;
      }
    } catch (e) { /* без вибрации */ }
    for (let i = 0; i < 8; i++) setTimeout(hapticTap, i * 140);
  }

  // ===== Фоновая музыка раунда (генерируется Web Audio, без файлов) =====
  // «Нуар-джаз»: шагающий контрабас, мягкие аккорды, щётки со свингом и приглушённая труба.
  // В последнюю минуту темп растёт.
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const NOIR = {
    bpm: 96,
    tenseBpm: 118,
    steps: 32, // восьмые, 4 такта
    bass: [38, 41, 45, 48, 34, 38, 41, 45, 40, 43, 46, 49, 33, 37, 40, 43], // четверти: Dm · B♭ · Em7♭5 · A7
    chords: [[62, 65, 69, 72], [58, 62, 65, 69], [64, 67, 70, 74], [61, 64, 67, 69]],
    horn: { 2: 69, 3: 70, 4: 69, 10: 65, 12: 62, 18: 69, 19: 72, 20: 70, 26: 69, 28: 61 }
  };

  const music = {
    playing: false, master: null, timerId: null, nextTime: 0, step: 0, noise: null,

    start() {
      if (!settings.music || this.playing) return;
      unlockAudio();
      if (!audioCtx) return;
      try {
        const now = audioCtx.currentTime;
        this.master = audioCtx.createGain();
        this.master.gain.setValueAtTime(0.0001, now);
        this.master.gain.exponentialRampToValueAtTime(0.6, now + 0.8);
        this.master.connect(audioCtx.destination);
        if (!this.noise) {
          const len = Math.floor(audioCtx.sampleRate * 0.3);
          this.noise = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
          const d = this.noise.getChannelData(0);
          for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        }
        this.step = 0;
        this.nextTime = now + 0.1;
        this.playing = true;
        this.schedule();
        this.timerId = setInterval(() => this.schedule(), 200);
      } catch (e) { this.playing = false; }
    },

    stop() {
      if (!this.playing) return;
      this.playing = false;
      clearInterval(this.timerId);
      const g = this.master;
      this.master = null;
      try {
        const now = audioCtx.currentTime;
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
        setTimeout(() => g.disconnect(), 400);
      } catch (e) { /* уже остановлено */ }
    },

    schedule() {
      if (!this.playing || !audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const now = audioCtx.currentTime;
      if (this.nextTime < now) this.nextTime = now + 0.05; // догоняем после фона
      const tense = game && remainingMs() < 60000;
      const stepDur = 60 / (tense ? NOIR.tenseBpm : NOIR.bpm) / 2;
      while (this.nextTime < now + 0.8) {
        // свинг: каждая вторая восьмая чуть запаздывает
        const t = this.step % 2 ? this.nextTime + stepDur * 0.33 : this.nextTime;
        this.playStep(this.step, t, stepDur);
        this.nextTime += stepDur;
        this.step = (this.step + 1) % NOIR.steps;
      }
    },

    playStep(s, t, sd) {
      if (s % 2 === 0) {
        this.tone({ f: midi(NOIR.bass[s / 2]), t, len: sd * 1.9, type: 'triangle', cut: 700, vol: 0.4, a: 0.005 });
      }
      if (s % 8 === 0) {
        NOIR.chords[s / 8].forEach((n) => this.tone({ f: midi(n), t, len: sd * 7, vol: 0.035, a: 0.02 }));
      }
      this.brush(t, s % 2 ? 0.12 : 0.25, s % 2 ? 0.025 : 0.04, 'highpass', 6000); // райд
      if (s % 4 === 2) this.brush(t, 0.18, 0.05, 'bandpass', 2500);              // щётка на 2 и 4
      const note = NOIR.horn[s];
      if (note) {
        this.tone({
          f: midi(note), t, len: sd * (NOIR.horn[s + 1] ? 1 : 2.5),
          type: 'sawtooth', cut: 1300, vol: 0.07, vib: 0.008, a: 0.04
        });
      }
    },

    tone({ f, t, len, type = 'sine', vol = 0.2, a = 0.01, cut = 0, vib = 0 }) {
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = f;
      let node = osc;
      if (cut) {
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = cut;
        osc.connect(filter);
        node = filter;
      }
      if (vib) {
        const lfo = audioCtx.createOscillator();
        const depth = audioCtx.createGain();
        lfo.frequency.value = 5.5;
        depth.gain.value = f * vib;
        lfo.connect(depth).connect(osc.frequency);
        lfo.start(t);
        lfo.stop(t + len + 0.05);
      }
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      node.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + len + 0.05);
    },

    brush(t, len, vol, type, freq) {
      const src = audioCtx.createBufferSource();
      const filter = audioCtx.createBiquadFilter();
      const g = audioCtx.createGain();
      src.buffer = this.noise;
      filter.type = type;
      filter.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      src.connect(filter).connect(g).connect(this.master);
      src.start(t);
      src.stop(t + len + 0.02);
    }
  };

  function startTicking() {
    stopTicking();
    tickId = setInterval(tick, 250);
  }

  function stopTicking() {
    if (tickId) clearInterval(tickId);
    tickId = null;
  }

  function stopRound() {
    stopTicking();
    music.stop();
    releaseWakeLock();
    roundUI = null;
  }

  function tick() {
    if (!game) return;
    const t = game.timer;
    if (t.status === 'running' && remainingMs() <= 0) {
      t.status = 'done';
      t.remaining = 0;
      stopTicking();
      releaseWakeLock();
      music.stop();
      beepThreeTimes();
      vibrate();
    }
    updateTimerUI();
  }

  function onTimerButton() {
    const t = game.timer;
    if (t.status === 'idle' || t.status === 'paused') {
      unlockAudio();
      t.endAt = Date.now() + t.remaining;
      t.status = 'running';
      requestWakeLock();
      startTicking();
      music.start();
    } else if (t.status === 'running') {
      t.remaining = remainingMs();
      t.status = 'paused';
      stopTicking();
      releaseWakeLock();
      music.stop();
    }
    tick();
  }

  function updateTimerUI() {
    if (!roundUI || !game) return;
    const t = game.timer;
    const { box, time, status, timerBtn, revealBtn } = roundUI;
    time.textContent = formatTime(remainingMs());
    box.classList.toggle('is-done', t.status === 'done');
    box.classList.toggle('is-paused', t.status === 'paused');
    const labels = {
      idle: ['Таймер не запущен', 'Запустить таймер'],
      running: ['Идёт допрос', 'Пауза'],
      paused: ['Пауза', 'Продолжить'],
      done: ['Время вышло · голосуйте', '']
    };
    const [statusText, btnText] = labels[t.status];
    if (status.textContent !== statusText) status.textContent = statusText;
    timerBtn.hidden = t.status === 'done';
    if (btnText) timerBtn.textContent = btnText;
    if (!revealBtn.classList.contains('btn--armed')) {
      revealBtn.className = t.status === 'done' ? 'btn btn--primary' : 'btn';
    }
  }

  function renderRound() {
    stopRound();

    const time = h('div', { class: 'timer', role: 'timer', 'aria-label': 'Оставшееся время' });
    const status = h('div', { class: 'timer-status', 'aria-live': 'polite' });
    const box = h('div', { class: 'timer-box' }, time, status);

    const sorted = game.pool;
    // Алфавит идёт сверху вниз по первой колонке, затем по второй
    const list = h('ul', { class: 'loc-list', style: `grid-template-rows: repeat(${Math.ceil(sorted.length / 2)}, auto)` }, sorted.map((name) => {
      const btn = h('button', {
        type: 'button', class: 'loc-btn', text: name,
        'aria-pressed': String(game.crossed.has(name))
      });
      btn.addEventListener('click', () => {
        if (game.crossed.has(name)) game.crossed.delete(name); else game.crossed.add(name);
        btn.setAttribute('aria-pressed', String(game.crossed.has(name)));
      });
      return h('li', null, btn);
    }));

    const musicBtn = h('button', { type: 'button', class: 'btn btn--ghost music-btn' });
    const syncMusicBtn = () => {
      musicBtn.textContent = settings.music ? '♪ Музыка: вкл' : '♪ Музыка: выкл';
      musicBtn.setAttribute('aria-pressed', String(settings.music));
    };
    musicBtn.addEventListener('click', () => {
      settings.music = !settings.music;
      persist();
      syncMusicBtn();
      if (!settings.music) music.stop();
      else if (game.timer.status === 'running') music.start();
    });
    syncMusicBtn();

    const body = [
      h('div', { class: 'topbar topbar--end' }, musicBtn),
      box,
      h('p', { class: 'first' }, h('span', { class: 'kicker', text: 'Первым спрашивает' }), h('br'), h('strong', { text: game.firstAsker })),
      h('div', { class: 'loc-head' },
        h('h2', { class: 'kicker', text: 'Локации' }),
        h('span', { class: 'kicker', text: 'Нажми — вычеркнуть' })),
      list
    ];

    const revealBtn = confirmButton('Раскрыть карты', 'Точно? Нажми ещё раз', 'btn', renderResults);
    const timerBtn = h('button', { type: 'button', class: 'btn btn--primary' });
    timerBtn.addEventListener('click', onTimerButton);

    mount(screen('', body, [revealBtn, timerBtn]));
    roundUI = { box, time, status, timerBtn, revealBtn };
    updateTimerUI();
    if (game.timer.status === 'running') { startTicking(); requestWakeLock(); music.start(); }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !game || !roundUI) return;
    tick();
    if (game.timer.status === 'running') requestWakeLock();
  });

  // ===== Экран 5: итоги =====
  function renderResults() {
    stopRound();

    const body = [
      h('p', { class: 'kicker', text: 'Дело закрыто · локация' }),
      h('h1', { class: 'title reveal__loc', text: game.location }),
      h('ul', { class: 'roster' }, game.players.map((p) => h('li', { class: p.spy ? 'is-spy' : '' },
        h('span', { class: 'roster__name', text: p.name }),
        h('span', { class: 'roster__role', text: p.spy ? 'Шпион' : p.role })
      )))
    ];

    const toSettings = h('button', { type: 'button', class: 'btn', text: 'Настройки' });
    toSettings.addEventListener('click', renderSettings);
    const again = h('button', { type: 'button', class: 'btn btn--primary', text: 'Ещё раунд' });
    again.addEventListener('click', () => { deal(); renderPass(); });

    mount(screen('', body, h('div', { class: 'bar__row' }, toSettings, again)));
  }

  // ===== Старт =====
  renderSettings();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }
})();
