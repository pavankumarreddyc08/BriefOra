import initSqlJs from 'sql.js';
import fs from 'node:fs'; import path from 'node:path'; import {createRequire} from 'node:module';
import { config } from '../../config/env.js';
const dbPath = path.resolve(process.cwd(), config.dbPath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const require=createRequire(import.meta.url); const SQL=await initSqlJs({locateFile:file=>require.resolve(`sql.js/dist/${file}`)});
const binary=fs.existsSync(dbPath)?fs.readFileSync(dbPath):undefined; const raw=new SQL.Database(binary);
let transactionDepth=0; let dirty=false;
function persist(){if(transactionDepth){dirty=true;return;}fs.writeFileSync(dbPath,Buffer.from(raw.export()));dirty=false;}
export const db={
  exec(sql){raw.run(sql);const command=sql.trim().toUpperCase();if(command.startsWith('BEGIN'))transactionDepth++;if(command.startsWith('COMMIT')||command.startsWith('ROLLBACK')){transactionDepth=Math.max(0,transactionDepth-1);if(transactionDepth===0&&dirty)persist();}else if(!transactionDepth)persist();},
  prepare(sql){return {
    run(...params){raw.run(sql,params);const changes=raw.getRowsModified();persist();return {changes};},
    get(...params){const s=raw.prepare(sql);try{s.bind(params);return s.step()?s.getAsObject():undefined;}finally{s.free();}},
    all(...params){const s=raw.prepare(sql),rows=[];try{s.bind(params);while(s.step())rows.push(s.getAsObject());return rows;}finally{s.free();}}
  };}
};
db.exec(`CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT, size INTEGER, created_at TEXT NOT NULL, text TEXT NOT NULL, file_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready');
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, document_id TEXT NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL, location TEXT, FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(document_id);
CREATE TABLE IF NOT EXISTS summaries(id INTEGER PRIMARY KEY, document_id TEXT NOT NULL, kind TEXT NOT NULL, language TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(document_id,kind,language), FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, document_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, sources TEXT, created_at TEXT NOT NULL, FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS translations(cache_key TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL);`);
