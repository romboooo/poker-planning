(function () {
	'use strict';

	const app = document.getElementById('poker-planning-app');
	if (!app) return;

	const deck = [0.5, 1, 2, 3, 5, 8, 13, 20, 40];
	const roomFromUrl = new URLSearchParams(window.location.search).get('room') || '';
	const home = document.getElementById('pp-home');
	const roomView = document.getElementById('pp-room');
	const errorBox = document.getElementById('pp-error');
	const toast = document.getElementById('pp-toast');
	const deckRoot = document.getElementById('pp-deck');
	const playerRoot = document.getElementById('pp-player-list');
	const colorScheme = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
	let current = null;
	let pollTimer = null;
	let toastTimer = null;

	function syncTheme() {
		const themeNodes = [document.documentElement, document.body];
		let explicitTheme = null;
		themeNodes.forEach(function (node) {
			if (!node || explicitTheme !== null) return;
			const declaredTheme = (node.dataset.theme || node.dataset.colorScheme || '').toLowerCase();
			if (declaredTheme === 'dark' || declaredTheme === 'light') {
				explicitTheme = declaredTheme;
				return;
			}
			const classes = typeof node.className === 'string' ? node.className : '';
			if (/(?:^|[\s_-])dark(?:$|[\s_-])/i.test(classes)) explicitTheme = 'dark';
			else if (/(?:^|[\s_-])light(?:$|[\s_-])/i.test(classes)) explicitTheme = 'light';
		});
		const isDark = explicitTheme ? explicitTheme === 'dark' : true;
		if (isDark) app.dataset.ppTheme = 'dark';
		else delete app.dataset.ppTheme;
	}

	syncTheme();
	if (colorScheme && colorScheme.addEventListener) colorScheme.addEventListener('change', syncTheme);
	if (window.MutationObserver) {
		const themeObserver = new MutationObserver(syncTheme);
		[document.documentElement, document.body].forEach(function (node) {
			if (node) themeObserver.observe(node, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-color-scheme'] });
		});
	}

	const apiUrl = new URL('https://poker-planning.fabledbull515.chatgpt.site/api/poker');

	function setError(message) {
		errorBox.textContent = message || '';
		errorBox.hidden = !message;
	}

	function showToast(message) {
		toast.textContent = message;
		toast.classList.add('is-visible');
		window.clearTimeout(toastTimer);
		toastTimer = window.setTimeout(function () { toast.classList.remove('is-visible'); }, 2400);
	}

	function credentials(room) {
		try {
			return JSON.parse(window.localStorage.getItem('poker-planning:' + room) || 'null');
		} catch (error) {
			return null;
		}
	}

	async function request(action, values) {
		const payload = Object.assign({ action: action }, values || {});
		if (current) {
			payload.room = current.room;
			payload.member_id = current.member.id;
			payload.member_secret = current.member.secret;
		}
		const response = await fetch(apiUrl.toString(), {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify(payload)
		});
		let result;
		try {
			result = await response.json();
		} catch (error) {
			throw new Error('Сервер вернул неожиданный ответ. Обновите страницу.');
		}
		if (!response.ok || !result.ok) throw new Error(result.error || 'Не удалось выполнить действие.');
		return result;
	}

	function updateUrl(room) {
		const url = new URL(window.location.href);
		url.search = '';
		url.searchParams.set('room', room);
		window.history.replaceState({}, '', url.toString());
	}

	function saveCredentials(room, member, name) {
		const value = { id: member.id, secret: member.secret, name: name };
		window.localStorage.setItem('poker-planning:' + room, JSON.stringify(value));
	}

	function openRoom(room, member, name, state) {
		current = { room: room, member: member, name: name, readyAtMs: null, countdownTimer: null, renderedRound: null, renderedRevealed: null };
		saveCredentials(room, member, name);
		updateUrl(room);
		home.hidden = true;
		roomView.hidden = false;
		setError('');
		render(state);
		if (pollTimer) window.clearInterval(pollTimer);
		pollTimer = window.setInterval(refresh, 1400);
	}

	function formatNumber(value) {
		return Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
	}

	function stopCountdown() {
		if (current && current.countdownTimer) window.clearInterval(current.countdownTimer);
		if (current) {
			current.countdownTimer = null;
			current.readyAtMs = null;
			current.countdownExpired = false;
		}
	}

	function updateCountdown() {
		if (!current || !current.readyAtMs) return;
		const remaining = current.readyAtMs - (Date.now() + (current.serverClockOffset || 0));
		const countdown = document.getElementById('pp-countdown');
		if (remaining <= 0) {
			countdown.hidden = true;
			document.getElementById('pp-table-status').textContent = 'Открываем карты…';
			document.getElementById('pp-table-hint').textContent = 'Сейчас будет вскрытие';
			if (current.countdownTimer) window.clearInterval(current.countdownTimer);
			current.countdownTimer = null;
			if (!current.countdownExpired) {
				current.countdownExpired = true;
				refresh();
			}
			return;
		}

		countdown.textContent = String(Math.ceil(remaining / 1000));
		countdown.hidden = false;
		document.getElementById('pp-table-status').textContent = 'Все проголосовали';
		document.getElementById('pp-table-hint').textContent = 'Открываем через';
	}

	function syncCountdown(state) {
		const readyAtMs = Number(state.ready_at_ms) || null;
		if (state.revealed || !readyAtMs) {
			stopCountdown();
			document.getElementById('pp-countdown').hidden = true;
			return;
		}

		current.serverClockOffset = Number(state.server_now_ms) - Date.now();
		if (current.readyAtMs !== readyAtMs) {
			stopCountdown();
			current.readyAtMs = readyAtMs;
		}
		current.countdownExpired = false;
		if (!current.countdownTimer) current.countdownTimer = window.setInterval(updateCountdown, 100);
		updateCountdown();
	}

	function render(state) {
		if (!state || !current) return;
		current.selected = state.my_vote === null ? null : Number(state.my_vote);
		document.getElementById('pp-room-name').textContent = state.name;
		document.getElementById('pp-round-label').textContent = 'Раунд ' + state.round;
		const taskUrl = String(state.task_url || '');
		const taskInput = document.getElementById('pp-task-url');
		if (document.activeElement !== taskInput) taskInput.value = taskUrl;
		taskInput.disabled = !!state.revealed;
		document.getElementById('pp-task-save').disabled = !!state.revealed;
		const taskLink = document.getElementById('pp-task-open');
		if (taskUrl) {
			taskLink.href = taskUrl;
			taskLink.hidden = false;
		} else {
			taskLink.removeAttribute('href');
			taskLink.hidden = true;
		}
		document.getElementById('pp-room-code').textContent = state.code;
		document.getElementById('pp-player-count').textContent = state.players.length;
		document.getElementById('pp-host-pill').hidden = !state.is_host;
		document.getElementById('pp-room-controls').hidden = !state.is_host;
		document.getElementById('pp-reveal').hidden = state.revealed;
		document.getElementById('pp-reset').hidden = !state.revealed;
		document.getElementById('pp-deck-hint').textContent = state.revealed
			? 'Карты открыты. Ведущий может начать новый раунд.'
			: 'Выберите часы. Нажмите выбранную карту ещё раз, чтобы снять голос.';

		const votedCount = state.players.filter(function (player) { return player.voted; }).length;
		document.getElementById('pp-vote-progress').textContent = state.revealed
			? 'Карты открыты · ' + votedCount + ' из ' + state.players.length + ' оценок'
			: 'Выбрали карту: ' + votedCount + ' из ' + state.players.length;
		document.getElementById('pp-table-round').textContent = 'Раунд ' + state.round;
		document.getElementById('pp-table-status').textContent = state.revealed
			? 'Оценки на столе'
			: (votedCount === state.players.length && state.players.length ? 'Готовы вскрыть карты' : 'Карты закрыты');
		document.getElementById('pp-table-hint').textContent = 'Все оценки откроются одновременно';
		const revealButton = document.getElementById('pp-reveal');
		revealButton.disabled = !state.revealed && !!state.ready_at_ms;
		revealButton.textContent = state.ready_at_ms ? 'Идёт отсчёт…' : 'Открыть карты';
		syncCountdown(state);

		const playerCount = state.players.length;
		const animateReveal = state.revealed
			&& current.renderedRound === Number(state.round)
			&& current.renderedRevealed === false;
		const cardsToFlip = [];
		playerRoot.replaceChildren.apply(playerRoot, state.players.map(function (player, index) {
			const item = document.createElement('div');
			item.className = 'pp-seat' + (player.id === current.member.id ? ' is-self' : '');
			const angle = (Math.PI * 2 * index / Math.max(playerCount, 1)) - Math.PI / 2;
			item.style.left = (50 + Math.cos(angle) * 37) + '%';
			item.style.top = (50 + Math.sin(angle) * 37) + '%';
			const avatar = document.createElement('span');
			avatar.className = 'pp-avatar' + (player.online ? ' is-online' : '');
			avatar.textContent = player.name.trim().charAt(0).toLocaleUpperCase('ru-RU') || '?';
			const name = document.createElement('span');
			name.className = 'pp-player-name';
			name.textContent = player.name + (player.id === current.member.id ? ' (вы)' : '');
			const card = document.createElement('span');
			card.className = 'pp-playing-card' + (player.voted ? ' has-voted' : '');
			const inner = document.createElement('span');
			inner.className = 'pp-playing-card-inner';
			const back = document.createElement('span');
			back.className = 'pp-playing-card-back';
			back.textContent = '♠';
			const face = document.createElement('span');
			face.className = 'pp-playing-card-face';
			face.textContent = player.vote === null ? '—' : formatNumber(player.vote);
			inner.append(back, face);
			card.appendChild(inner);
			if (state.revealed && !animateReveal) card.classList.add('is-face');
			if (animateReveal) {
				inner.style.transitionDelay = (index * 75) + 'ms';
				cardsToFlip.push(card);
			}
			card.setAttribute('aria-label', state.revealed
				? (player.vote === null ? player.name + ': без оценки' : player.name + ': ' + formatNumber(player.vote) + ' часа')
				: player.name + (player.voted ? ': оценка выбрана' : ': ожидает оценки'));
			item.append(avatar, name, card);
			return item;
		}));
		current.renderedRound = Number(state.round);
		current.renderedRevealed = !!state.revealed;
		if (cardsToFlip.length) {
			window.requestAnimationFrame(function () {
				cardsToFlip.forEach(function (card) { card.classList.add('is-face'); });
			});
		}

		const result = document.getElementById('pp-result');
		result.hidden = !state.summary;
		if (state.summary) {
			document.getElementById('pp-average').textContent = formatNumber(state.summary.average);
			document.getElementById('pp-mode').textContent = state.summary.mode.map(formatNumber).join(' / ');
			document.getElementById('pp-mode-caption').textContent = state.summary.mode.length > 1 ? 'ничья · часа' : 'часа';
		}

		const selected = current.selected;
		Array.from(deckRoot.children).forEach(function (button) {
			const isSelected = Number(button.dataset.value) === selected;
			button.classList.toggle('is-selected', isSelected);
			button.setAttribute('aria-pressed', String(isSelected));
			button.disabled = !!state.revealed;
		});
	}

	async function refresh() {
		if (!current) return;
		try {
			const result = await request('state');
			setError('');
			render(result.state);
		} catch (error) {
			setError(error.message);
		}
	}

	function makeDeck() {
		deck.forEach(function (value) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'pp-card';
			button.dataset.value = String(value);
			button.textContent = formatNumber(value);
			button.setAttribute('aria-label', formatNumber(value) + ' часа');
			button.addEventListener('click', async function () {
				if (!current) return;
				try {
					const nextVote = current.selected === value ? null : value;
					const result = await request('vote', { vote: nextVote });
					current.selected = nextVote;
					render(result.state);
					setError('');
				} catch (error) {
					setError(error.message);
				}
			});
			deckRoot.appendChild(button);
		});
	}

	document.getElementById('pp-create-form').addEventListener('submit', async function (event) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		try {
			setError('');
			const result = await request('create', { name: form.get('name'), room_name: form.get('room_name') });
			openRoom(result.room, result.member, form.get('name'), result.state);
		} catch (error) {
			setError(error.message);
		}
	});

	document.getElementById('pp-join-form').addEventListener('submit', async function (event) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const room = String(form.get('room') || '').trim().toUpperCase();
		const saved = credentials(room);
		try {
			setError('');
			const result = await request('join', {
				room: room,
				name: form.get('name'),
				member_id: saved && saved.id,
				member_secret: saved && saved.secret
			});
			openRoom(room, result.member, form.get('name'), result.state);
		} catch (error) {
			setError(error.message);
		}
	});

	document.getElementById('pp-task-form').addEventListener('submit', async function (event) {
		event.preventDefault();
		if (!current) return;
		const taskUrl = document.getElementById('pp-task-url').value.trim();
		try {
			const result = await request('set_task_url', { task_url: taskUrl });
			render(result.state);
			setError('');
			showToast(taskUrl ? 'Ссылка на задачу сохранена' : 'Ссылка удалена');
		} catch (error) {
			setError(error.message);
		}
	});

	document.getElementById('pp-copy-link').addEventListener('click', async function () {
		if (!current) return;
		try {
			await navigator.clipboard.writeText(window.location.href);
			showToast('Ссылка скопирована');
		} catch (error) {
			window.prompt('Скопируйте ссылку на комнату', window.location.href);
		}
	});

	document.getElementById('pp-copy-code').addEventListener('click', async function () {
		if (!current) return;
		try {
			await navigator.clipboard.writeText(current.room);
			showToast('Код скопирован');
		} catch (error) {
			window.prompt('Код комнаты', current.room);
		}
	});

	document.getElementById('pp-reveal').addEventListener('click', async function () {
		try {
			const result = await request('reveal');
			render(result.state);
		} catch (error) {
			setError(error.message);
		}
	});

	document.getElementById('pp-reset').addEventListener('click', async function () {
		try {
			const result = await request('reset');
			current.selected = null;
			render(result.state);
		} catch (error) {
			setError(error.message);
		}
	});

	document.getElementById('pp-leave').addEventListener('click', function () {
		if (pollTimer) window.clearInterval(pollTimer);
		pollTimer = null;
		stopCountdown();
		current = null;
		roomView.hidden = true;
		home.hidden = false;
		setError('');
		const url = new URL(window.location.href);
		url.search = '';
		window.history.replaceState({}, '', url.toString());
	});

	makeDeck();

	if (roomFromUrl) {
		const saved = credentials(roomFromUrl);
		const roomInput = document.querySelector('#pp-join-form [name="room"]');
		const nameInput = document.querySelector('#pp-join-form [name="name"]');
		roomInput.value = roomFromUrl;
		if (saved && saved.name) {
			nameInput.value = saved.name;
			request('join', {
				room: roomFromUrl,
				name: saved.name,
				member_id: saved.id,
				member_secret: saved.secret
			}).then(function (result) {
				openRoom(roomFromUrl, result.member, saved.name, result.state);
			}).catch(function (error) {
				setError(error.message);
			});
		} else {
			nameInput.focus();
		}
	}
})();
