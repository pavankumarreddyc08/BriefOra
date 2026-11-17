import { db } from '../storage/sqlite.js';
export function makeChunks(text, max = 1100, overlap = 140) {
  const paras = text.split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(Boolean); const chunks=[]; let buf='';
  for (const p of paras) { const marker=/^\[(?:Page \d+|Slide \d+|Sheet: [^\]]+)\]$/.test(p);if(marker&&buf){chunks.push(buf);buf='';}const parts=p.length>max?p.match(new RegExp(`.{1,${max}}(?:\\s|$)|.{1,${max}}`,'gs'))||[p]:[p]; for(const part of parts){if (buf && (buf.length + part.length + 1 > max)) { chunks.push(buf); const carry=marker?'':buf.slice(-Math.min(overlap,Math.max(0,max-part.length-1))); buf = carry ? `${carry} ${part}` : part; } else buf += (buf ? ' ' : '') + part;} }
  if (buf) chunks.push(buf); return chunks;
}
export function indexDocument(documentId, text) {
  const parts = makeChunks(text); const ins = db.prepare('INSERT INTO chunks(document_id,ordinal,text,location) VALUES(?,?,?,?)');
  db.exec('BEGIN'); try { db.prepare('DELETE FROM chunks WHERE document_id=?').run(documentId); parts.forEach((p,i)=>{const sheet=p.match(/\[Sheet: ([^\]]+)\]/);const row=p.match(/\[Sheet: [^\]]+\]\s*Row (\d+)/);const location=p.match(/\[(Page \d+|Slide \d+)\]/)?.[1]||(sheet?`Sheet: ${sheet[1]}${row?`, row ${row[1]}`:''}`:p.match(/^#{1,6}\s+(.+)$/m)?.[1]||null);ins.run(documentId,i+1,p,location);}); db.exec('COMMIT'); } catch(e) { db.exec('ROLLBACK'); throw e; } return parts.length;
}
const terms = q => [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])];
export function retrieve(documentId, query, limit=5) {
  const q=terms(query); if(!q.length) return [];
  const chunks=db.prepare('SELECT id,ordinal,text,location FROM chunks WHERE document_id=?').all(documentId);
  return chunks.map(c=>{const low=c.text.toLowerCase();const score=q.reduce((s,t)=>s+(low.includes(t)? 1 + (low.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gu'))||[]).length*.15:0),0);return {...c,score};}).filter(c=>c.score>=Math.max(1.25,q.length*.2)).sort((a,b)=>b.score-a.score).slice(0,limit);
}
