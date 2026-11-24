'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT) || 3000;
const allowedOrigins = new Set((process.env.CORS_ALLOWED_ORIGINS || '')
	.split(',').map((origin) => origin.trim()).filter(Boolean));
const deck = new Set([0.5, 1, 2, 3, 5, 8, 13, 20, 40]);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const schema = `
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  room_json JSONB NOT NULL,
  created_at BIGINT NOT NULL
);
`;

function sendJson(res, status, value, extraHeaders = {}) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
		...extraHeaders
	});
	res.end(body);
}

function corsHeaders(origin, req) {
	if (!origin) return {};
	const protoHeader = req.headers['x-forwarded-proto'];
	const forwardedProto = String(protoHeader || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
	const sameOrigin = `${forwardedProto}://${req.headers.host}`;
	if (origin === sameOrigin) return {};
	if (!allowedOrigins.has(origin)) return null;
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Accept',
		'Access-Control-Max-Age': '600',
		'Vary': 'Origin'
	};
}

function readJson(req) {
	return new Promise((resolve, reject) => {
		let raw = '';
		let oversized = false;
		req.setEncoding('utf8');
		req.on('data', (chunk) => {
			if (oversized) return;
			raw += chunk;
			if (raw.length > 32 * 1024) {
				oversized = true;
				raw = '';
			}
		});
		req.on('end', () => {
			if (oversized) return reject(Object.assign(new Error('Запрос слишком большой.'), { status: 413 }));
			try { resolve(raw ? JSON.parse(raw) : {}); }
			catch { reject(Object.assign(new Error('Некорректный JSON.'), { status: 400 })); }
		});
		req.on('error', reject);
	});
}

function cleanName(value, label = 'Имя') {
	const name = String(value || '').trim().slice(0, 40);
	if (!name) throw Object.assign(new Error(`Укажите: ${label.toLowerCase()}.`), { status: 400 });
	return name;
}

function hashSecret(secret) {
	return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

function newMember(name, now) {
	const id = crypto.randomUUID();
	const secret = crypto.randomBytes(32).toString('base64url');
	return {
		player: { id, name, secret_hash: hashSecret(secret), vote: null, last_seen: now },
		credentials: { id, secret }
	};
}

function makeState(room, memberId, now) {
	const voted = room.players.filter((player) => player.vote !== null && player.vote !== undefined)
		.map((player) => Number(player.vote));
	let summary = null;
	if (room.revealed && voted.length) {
		const counts = new Map();
		voted.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
		const highest = Math.max(...counts.values());
		summary = {
			average: voted.reduce((sum, value) => sum + value, 0) / voted.length,
			mode: Array.from(counts.entries()).filter((entry) => entry[1] === highest)
				.map((entry) => entry[0]).sort((a, b) => a - b)
		};
	}
	const mine = room.players.find((player) => player.id === memberId);
	return {
		code: room.code,
		name: room.name,
		created_at: room.created_at,
		round: room.round,
		task_url: room.task_url || '',
		revealed: !!room.revealed,
		ready_at_ms: room.ready_at_ms || null,
		server_now_ms: now,
		is_host: room.host_id === memberId,
		my_vote: mine && mine.vote !== null ? Number(mine.vote) : null,
		players: room.players.map((player) => ({
			id: player.id,
			name: player.name,
			voted: player.vote !== null && player.vote !== undefined,
			vote: room.revealed && player.vote !== null && player.vote !== undefined ? Number(player.vote) : null,
			online: now - Number(player.last_seen || 0) < 20000
		})),
		summary
	};
}

function maybeFinishCountdown(room, now) {
	if (!room.revealed && room.ready_at_ms && Number(room.ready_at_ms) <= now) {
		room.revealed = true;
		room.ready_at_ms = null;
	}
}

async function transaction(callback) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const result = await callback(client);
		await client.query('COMMIT');
		return result;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

async function handleAction(payload) {
	const action = String(payload.action || '');
	const now = Date.now();

	if (action === 'create') {
		const playerName = cleanName(payload.name);
		const roomName = String(payload.room_name || '').trim().slice(0, 80) || 'Планирование';
		for (let attempt = 0; attempt < 5; attempt++) {
			const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
			const code = Array.from(crypto.randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join('');
			const member = newMember(playerName, now);
			const room = {
				name: roomName, created_at: now, round: 1, task_url: '', revealed: false,
				ready_at_ms: null, host_id: member.player.id, players: [member.player], code
			};
			try {
				await pool.query('INSERT INTO rooms (code, room_json, created_at) VALUES ($1, $2::jsonb, $3)', [code, JSON.stringify(room), now]);
				return { room: code, member: member.credentials, state: makeState(room, member.player.id, now) };
			} catch (error) {
				if (error.code !== '23505') throw error;
			}
		}
		throw Object.assign(new Error('Не удалось создать комнату. Попробуйте ещё раз.'), { status: 503 });
	}

	const code = String(payload.room || '').trim().toUpperCase();
	if (!/^[A-Z0-9]{4,8}$/.test(code)) throw Object.assign(new Error('Проверьте код комнаты.'), { status: 400 });

	return transaction(async (client) => {
		const found = await client.query('SELECT room_json FROM rooms WHERE code = $1 FOR UPDATE', [code]);
		if (!found.rowCount) throw Object.assign(new Error('Комната не найдена. Проверьте код.'), { status: 404 });
		const room = found.rows[0].room_json;
		maybeFinishCountdown(room, now);

		if (action === 'join') {
			const playerName = cleanName(payload.name);
			const saved = room.players.find((player) => player.id === payload.member_id);
			let credentials;
			if (saved && payload.member_secret && saved.secret_hash === hashSecret(payload.member_secret)) {
				saved.name = playerName;
				saved.last_seen = now;
				credentials = { id: saved.id, secret: String(payload.member_secret) };
			} else {
				const member = newMember(playerName, now);
				room.players.push(member.player);
				credentials = member.credentials;
			}
			await client.query('UPDATE rooms SET room_json = $2::jsonb WHERE code = $1', [code, JSON.stringify(room)]);
			return { member: credentials, state: makeState(room, credentials.id, now) };
		}

		const member = room.players.find((player) => player.id === payload.member_id);
		if (!member || !payload.member_secret || member.secret_hash !== hashSecret(payload.member_secret)) {
			throw Object.assign(new Error('Не удалось войти в комнату. Введите имя ещё раз.'), { status: 401 });
		}
		member.last_seen = now;

		if (action === 'state') {
			// Polling also persists presence and completes the shared reveal countdown.
		} else if (action === 'vote') {
			if (room.revealed) throw Object.assign(new Error('Раунд уже открыт.'), { status: 409 });
			const vote = payload.vote === null ? null : Number(payload.vote);
			if (vote !== null && !deck.has(vote)) throw Object.assign(new Error('Выберите карту из колоды.'), { status: 400 });
			member.vote = vote;
			const everyoneVoted = room.players.length > 0 && room.players.every((player) => player.vote !== null && player.vote !== undefined);
			room.ready_at_ms = everyoneVoted ? (room.ready_at_ms || now + 4000) : null;
		} else if (action === 'set_task_url') {
			if (room.host_id !== member.id) throw Object.assign(new Error('Ссылку может менять только ведущий.'), { status: 403 });
			const taskUrl = String(payload.task_url || '').trim();
			if (taskUrl && taskUrl.length > 2048) throw Object.assign(new Error('Ссылка слишком длинная.'), { status: 400 });
			if (taskUrl) {
				let parsed;
				try { parsed = new URL(taskUrl); } catch { throw Object.assign(new Error('Укажите корректную ссылку.'), { status: 400 }); }
				if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('Ссылка должна начинаться с http:// или https://.'), { status: 400 });
			}
			room.task_url = taskUrl;
		} else if (action === 'reveal') {
			if (room.host_id !== member.id) throw Object.assign(new Error('Открыть карты может только ведущий.'), { status: 403 });
			room.revealed = true;
			room.ready_at_ms = null;
		} else if (action === 'reset') {
			if (room.host_id !== member.id) throw Object.assign(new Error('Начать новый раунд может только ведущий.'), { status: 403 });
			room.round = Number(room.round || 0) + 1;
			room.revealed = false;
			room.ready_at_ms = null;
			room.players.forEach((player) => { player.vote = null; });
		} else {
			throw Object.assign(new Error('Неизвестное действие.'), { status: 400 });
		}

		await client.query('UPDATE rooms SET room_json = $2::jsonb WHERE code = $1', [code, JSON.stringify(room)]);
		return { state: makeState(room, member.id, now) };
	});
}

const staticFiles = {
	'/': ['index.html', 'text/html; charset=utf-8'],
	'/index.html': ['index.html', 'text/html; charset=utf-8'],
	'/app.js': ['app.js', 'text/javascript; charset=utf-8'],
	'/app.css': ['app.css', 'text/css; charset=utf-8'],
	'/favicon.ico': ['favicon.ico', 'image/x-icon']
};

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
	if (url.pathname === '/healthz' && req.method === 'GET') return sendJson(res, 200, { ok: true });

	if (url.pathname === '/api/poker') {
		const origin = req.headers.origin;
		const headers = corsHeaders(origin, req);
		if (headers === null) return sendJson(res, 403, { ok: false, error: 'Origin is not allowed.' }, { Vary: 'Origin' });
		if (req.method === 'OPTIONS') {
			res.writeHead(204, headers || {});
			return res.end();
		}
		if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed.' }, headers || {});
		try {
			const payload = await readJson(req);
			if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
				throw Object.assign(new Error('Ожидался JSON-объект.'), { status: 400 });
			}
			const result = await handleAction(payload);
			return sendJson(res, 200, { ok: true, ...result }, headers || {});
		} catch (error) {
			const status = Number(error.status) || 500;
			if (status >= 500) console.error('Poker API error:', error.message);
			return sendJson(res, status, { ok: false, error: status >= 500 ? 'Внутренняя ошибка сервера.' : error.message }, headers || {});
		}
	}

	if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
	const file = staticFiles[url.pathname];
	if (!file) return sendJson(res, 404, { error: 'Not found.' });
	const filePath = path.join(root, file[0]);
	fs.readFile(filePath, (error, content) => {
		if (error) return sendJson(res, 404, { error: 'Not found.' });
		res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': url.pathname === '/' || url.pathname === '/index.html' ? 'no-cache' : 'public, max-age=300' });
		res.end(req.method === 'HEAD' ? undefined : content);
	});
});

async function start() {
	if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
	await pool.query(schema);
	server.listen(port, '0.0.0.0', () => console.log(`Planning Poker listening on ${port}`));
}

start().catch((error) => {
	console.error('Could not start Planning Poker:', error.message);
	process.exit(1);
});

process.on('SIGTERM', () => server.close(() => pool.end(() => process.exit(0))));
process.on('SIGINT', () => server.close(() => pool.end(() => process.exit(0))));
