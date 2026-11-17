import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from './config/env.js';
import { db } from './services/storage/sqlite.js';
import { extract, hasValidSignature } from './services/document/extract.js';
import { indexDocument, retrieve } from './services/retrieval/index.js';
import { summarize, answer } from './services/ai/openrouter.service.js';
import { translate, LANGUAGES } from './services/translation/sarvam.service.js';
import { notFoundMessage } from './services/translation/messages.js';
import { exportFile } from './services/export/index.js';

const app = express();
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: (origin, callback) => {
  let localDevOrigin = false;
  try { const url = new URL(origin); const port = Number(url.port); localDevOrigin = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && port >= 5173 && port <= 5199; } catch {}
  callback(null, !origin || origin === config.clientOrigin || localDevOrigin);
} }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false }));

const uploadDir = path.resolve('uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });
const now = () => new Date().toISOString();
const docSelect = 'SELECT id,name,mime,size,created_at,status FROM documents';
const acceptedExtensions = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.txt', '.md', '.html', '.htm', '.json', '.rtf']);

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'briefora-api', aiConfigured: Boolean(config.openRouterKey && config.openRouterModel), translationConfigured: Boolean(config.sarvamKey) }));
app.get('/api/settings/languages', (_req, res) => res.json({ languages: Object.keys(LANGUAGES), maxUploadMb: config.maxUploadMb }));
app.get('/api/documents', (_req, res) => res.json({ documents: db.prepare(`${docSelect} ORDER BY created_at DESC`).all() }));

app.post('/api/documents/upload', upload.single('file'), async (req, res, next) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: { code: 'FILE_REQUIRED', message: 'Choose a file to upload.' } });
  const extension = path.extname(file.originalname).toLowerCase();
  let finalPath;
  try {
    if (!acceptedExtensions.has(extension)) throw Object.assign(new Error('This file format is not supported.'), { status: 415, code: 'UNSUPPORTED_FORMAT' });
    const bytes = fs.readFileSync(file.path);
    if (!hasValidSignature(file.originalname, bytes)) throw Object.assign(new Error('The file contents do not match the selected file format.'), { status: 415, code: 'INVALID_FILE_SIGNATURE' });
    const text = await extract(file);
    if (!text.trim()) throw Object.assign(new Error('No readable text was found in this file.'), { status: 422, code: 'EMPTY_DOCUMENT' });
    const id = randomUUID();
    const name = path.basename(file.originalname).replace(/[^\p{L}\p{N}._ -]/gu, '_');
    finalPath = path.join(uploadDir, `${id}${extension}`);
    fs.renameSync(file.path, finalPath);
    db.prepare('INSERT INTO documents(id,name,mime,size,created_at,text,file_path) VALUES(?,?,?,?,?,?,?)').run(id, name, file.mimetype, file.size, now(), text, finalPath);
    indexDocument(id, text);
    res.status(201).json({ document: { id, name, mime: file.mimetype, size: file.size, created_at: now(), status: 'ready', preview: text.slice(0, 1500) } });
  } catch (error) {
    fs.rmSync(file.path, { force: true });
    if (finalPath) fs.rmSync(finalPath, { force: true });
    next(error);
  }
});

app.get('/api/documents/:id', (req, res) => {
  const doc = db.prepare(`${docSelect} WHERE id=?`).get(req.params.id);
  if (!doc) return res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } });
  res.json({ document: doc });
});
app.get('/api/documents/:id/content', (req, res) => {
  const doc = db.prepare('SELECT text FROM documents WHERE id=?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } });
  res.json({ text: doc.text });
});
app.delete('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT file_path FROM documents WHERE id=?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } });
  db.prepare('DELETE FROM documents WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM translations').run();
  try { fs.rmSync(doc.file_path, { force: true }); } catch { console.warn('An uploaded file could not be removed after document deletion.'); }
  res.json({ ok: true });
});

const language = z.enum(['en', 'hi', 'te', 'kn', 'ta']);
const summarySchema = z.object({ kind: z.enum(['short', 'detailed', 'bullets', 'notes', 'takeaways', 'definitions', 'chapters']).default('short'), language: language.default('en') });
app.post('/api/documents/:id/summarize', async (req, res, next) => {
  try {
    const parsed = summarySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid summary settings.' } });
    const doc = db.prepare('SELECT text FROM documents WHERE id=?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } });
    const { kind, language: outputLanguage } = parsed.data;
    let content = db.prepare('SELECT content FROM summaries WHERE document_id=? AND kind=? AND language=?').get(req.params.id, kind, outputLanguage)?.content;
    if (!content) {
      content = await summarize(doc.text, kind);
      if (outputLanguage !== 'en') content = await translate(content, 'en', outputLanguage);
      db.prepare('INSERT OR REPLACE INTO summaries(document_id,kind,language,content,created_at) VALUES(?,?,?,?,?)').run(req.params.id, kind, outputLanguage, content, now());
    }
    res.json({ summary: { content, kind, language: outputLanguage } });
  } catch (error) { next(error); }
});

const chatSchema = z.object({ question: z.string().trim().min(1).max(2000), questionLanguage: language.default('en'), language: language.default('en'), sourceLanguage: language.default('en') });
app.post('/api/documents/:id/chat', async (req, res, next) => {
  try {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Enter a question up to 2,000 characters.' } });
    const doc = db.prepare('SELECT id FROM documents WHERE id=?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } });
    const { question, questionLanguage, language: outputLanguage, sourceLanguage } = parsed.data;
    const previousQuestions = db.prepare("SELECT content FROM messages WHERE document_id=? AND role='user' ORDER BY id DESC LIMIT 2").all(doc.id).reverse().map(row => row.content);
    const contextualQuestion = [...previousQuestions, question].join('\n');
    const retrievalQuestion = questionLanguage === sourceLanguage ? contextualQuestion : await translate(contextualQuestion, questionLanguage, sourceLanguage);
    const hits = retrieve(doc.id, retrievalQuestion);
    if (!hits.length) {
      const message = notFoundMessage[outputLanguage] || notFoundMessage.en;
      db.prepare('INSERT INTO messages(document_id,role,content,sources,created_at) VALUES(?,?,?,?,?)').run(doc.id, 'user', question, '[]', now());
      db.prepare('INSERT INTO messages(document_id,role,content,sources,created_at) VALUES(?,?,?,?,?)').run(doc.id, 'assistant', message, '[]', now());
      return res.json({ answer: message, notFound: true, sources: [], language: outputLanguage });
    }
    const answerPrompt = `Earlier user questions for conversational context only: ${previousQuestions.join(' | ') || '(none)'}\nCurrent question: ${question}`;
    let content = await answer(answerPrompt, hits, sourceLanguage);
    const labels = [...content.matchAll(/\[S(\d+)\]/g)].map(match => Number(match[1]));
    let sources = [...new Set(labels)].filter(n => n > 0 && n <= hits.length).map(n => hits[n - 1]);
    if (!sources.length) sources = hits.slice(0, 2);
    if (outputLanguage !== sourceLanguage) content = await translate(content, sourceLanguage, outputLanguage);
    const safeSources = sources.map(source => ({ excerpt: source.text, location: source.location || null }));
    db.prepare('INSERT INTO messages(document_id,role,content,sources,created_at) VALUES(?,?,?,?,?)').run(doc.id, 'user', question, '[]', now());
    db.prepare('INSERT INTO messages(document_id,role,content,sources,created_at) VALUES(?,?,?,?,?)').run(doc.id, 'assistant', content, JSON.stringify(safeSources), now());
    res.json({ answer: content, notFound: false, sources: safeSources, language: outputLanguage });
  } catch (error) { next(error); }
});

app.get('/api/documents/:id/chat-history', (req, res) => {
  if (!db.prepare('SELECT 1 FROM documents WHERE id=?').get(req.params.id)) return res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } });
  const messages = db.prepare('SELECT id,role,content,sources,created_at FROM messages WHERE document_id=? ORDER BY id').all(req.params.id).map(message => ({ ...message, sources: JSON.parse(message.sources || '[]') }));
  res.json({ messages });
});
app.delete('/api/documents/:id/chat-history', (req, res) => {
  if (!db.prepare('SELECT 1 FROM documents WHERE id=?').get(req.params.id)) return res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } });
  db.prepare('DELETE FROM messages WHERE document_id=?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/documents/:id/translate', async (req, res, next) => {
  try {
    const schema = z.object({ text: z.string().min(1).max(50000), source: language, target: language });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid translation request.' } });
    res.json({ translation: await translate(parsed.data.text, parsed.data.source, parsed.data.target), language: parsed.data.target });
  } catch (error) { next(error); }
});
app.post('/api/documents/:id/export', async (req, res, next) => {
  try {
    const schema = z.object({ content: z.string().min(1).max(100000), title: z.string().max(200).default('Briefora Notes'), format: z.enum(['docx', 'pdf', 'txt']) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid export request.' } });
    const result = await exportFile(parsed.data);
    res.setHeader('Content-Type', result.mime);
    res.setHeader('Content-Disposition', `attachment; filename="briefora.${result.ext}"`);
    res.send(result.buffer);
  } catch (error) { next(error); }
});
app.post('/api/ai/test', async (_req, res, next) => {
  try { res.json({ ok: true, output: await summarize('Briefora test source.', 'short') }); } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: { code: error.code, message: error.code === 'LIMIT_FILE_SIZE' ? `File exceeds ${config.maxUploadMb} MB.` : 'Upload could not be processed.' } });
  const status = error.status || 500;
  const message = status < 500 || error.code ? error.message : 'The server could not complete this request. Check its configuration and try again.';
  res.status(status).json({ error: { code: error.code || 'INTERNAL_ERROR', message } });
});

export default app;
