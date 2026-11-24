'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const exportPath = process.argv[2] || path.resolve(__dirname, '..', 'rooms-export.json');

async function main() {
	if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL first.');
	if (!fs.existsSync(exportPath)) throw new Error(`Export file not found: ${exportPath}`);
	const rows = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
	if (!Array.isArray(rows)) throw new Error('Expected an array of D1 room rows.');
	const pool = new Pool({ connectionString: process.env.DATABASE_URL });
	let imported = 0;
	let skipped = 0;
	try {
		await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
			code TEXT PRIMARY KEY,
			room_json JSONB NOT NULL,
			created_at BIGINT NOT NULL
		)`);
		for (const row of rows) {
			const room = typeof row.room_json === 'string' ? JSON.parse(row.room_json) : row.room_json;
			if (!row.code || !room || typeof room !== 'object' || !Array.isArray(room.players)) {
				throw new Error('Export has a row with an invalid room shape.');
			}
			const result = await pool.query(
				'INSERT INTO rooms (code, room_json, created_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (code) DO NOTHING',
				[String(row.code), JSON.stringify(room), Number(row.created_at) || Number(room.created_at) || Date.now()]
			);
			if (result.rowCount) imported++;
			else skipped++;
		}
	} finally {
		await pool.end();
	}
	console.log(`Imported ${imported} rooms; skipped ${skipped} already present.`);
}

main().catch((error) => {
	console.error('Room import failed:', error.message);
	process.exitCode = 1;
});
