import test from 'node:test';
import assert from 'node:assert/strict';
import { config, validateOpenRouterConfig } from '../src/config/env.js';
import { answer, setOpenRouterClientFactoryForTests, summarize } from '../src/services/ai/openrouter.service.js';

const original={key:config.openRouterKey,model:config.openRouterModel,fallback:[...config.fallbackModels]};
function setup(factory, fallback=[]) {
  config.openRouterKey='test-key'; config.openRouterModel='test/primary'; config.fallbackModels=fallback;
  setOpenRouterClientFactoryForTests(()=>({chat:{completions:{create:factory}}}));
}
test('OpenRouter config validation catches missing values and malformed model IDs',()=>{
  assert.equal(validateOpenRouterConfig({openRouterKey:'',openRouterModel:'x/y',fallbackModels:[]}).code,'AI_NOT_CONFIGURED');
  assert.equal(validateOpenRouterConfig({openRouterKey:'test',openRouterModel:'',fallbackModels:[]}).code,'MODEL_NOT_CONFIGURED');
  assert.equal(validateOpenRouterConfig({openRouterKey:'test',openRouterModel:'bad model',fallbackModels:[]}).code,'INVALID_MODEL_ID');
  assert.deepEqual(validateOpenRouterConfig({openRouterKey:'test',openRouterModel:'a/b',fallbackModels:['a/b','c/d']}).models,['a/b','c/d']);
});
test('summary succeeds and sends the configured chat completion request',async()=>{
  const calls=[];setup(async body=>{calls.push(body);return{choices:[{message:{content:'Grounded summary'}}]};});
  try { assert.equal(await summarize('Solar panels convert sunlight into electrical energy.','short'),'Grounded summary');assert.equal(calls[0].model,'test/primary');assert.ok(calls[0].messages[1].content.includes('Solar panels')); }
  finally {config.openRouterKey=original.key;config.openRouterModel=original.model;config.fallbackModels=original.fallback;setOpenRouterClientFactoryForTests();}
});
test('provider auth and malformed request errors are classified and do not retry fallbacks',async()=>{
  for(const [status,code] of [[401,'AI_AUTH_FAILED'],[400,'AI_INVALID_REQUEST']]){
    let calls=0;setup(async()=>{calls++;throw Object.assign(new Error('provider rejection'),{status});},['test/fallback']);
    try { await assert.rejects(summarize('source text','short'),error=>error.code===code);assert.equal(calls,1); }
    finally {config.openRouterKey=original.key;config.openRouterModel=original.model;config.fallbackModels=original.fallback;setOpenRouterClientFactoryForTests();}
  }
});
test('rate limits and temporary provider errors try the next configured model once',async()=>{
  let calls=[];setup(async body=>{calls.push(body.model);if(calls.length===1)throw Object.assign(new Error('busy'),{status:429});return{choices:[{message:{content:'fallback success'}}]};},['test/fallback']);
  try {assert.equal(await summarize('source text','short'),'fallback success');assert.deepEqual(calls,['test/primary','test/fallback']);}
  finally {config.openRouterKey=original.key;config.openRouterModel=original.model;config.fallbackModels=original.fallback;setOpenRouterClientFactoryForTests();}
});
test('primary success does not call any fallback and all retryable failures stop after each model once',async()=>{
  let calls=[];setup(async body=>{calls.push(body.model);return{choices:[{message:{content:'primary success'}}]};},['test/fallback-1','test/fallback-2','test/fallback-3']);
  try {assert.equal(await summarize('source text','short'),'primary success');assert.deepEqual(calls,['test/primary']);}
  finally {config.openRouterKey=original.key;config.openRouterModel=original.model;config.fallbackModels=original.fallback;setOpenRouterClientFactoryForTests();}
  calls=[];setup(async body=>{calls.push(body.model);throw Object.assign(new Error('temporarily unavailable'),{status:503});},['test/fallback-1','test/fallback-2','test/fallback-3']);
  try {await assert.rejects(summarize('source text','short'),error=>error.code==='AI_PROVIDER_UNAVAILABLE'&&error.status===503);assert.deepEqual(calls,['test/primary','test/fallback-1','test/fallback-2','test/fallback-3']);}
  finally {config.openRouterKey=original.key;config.openRouterModel=original.model;config.fallbackModels=original.fallback;setOpenRouterClientFactoryForTests();}
});
test('connection failures return a distinct safe network error and use fallback once',async()=>{
  let calls=0;setup(async()=>{calls++;throw Object.assign(new Error('Connection error.'),{cause:Object.assign(new Error('fetch failed'),{code:'EAI_AGAIN'})});},['test/fallback']);
  try {await assert.rejects(summarize('source text','short'),error=>error.code==='AI_NETWORK_ERROR'&&/no HTTP response/.test(error.message));assert.equal(calls,2);}
  finally {config.openRouterKey=original.key;config.openRouterModel=original.model;config.fallbackModels=original.fallback;setOpenRouterClientFactoryForTests();}
});
test('insufficient quota does not retry, while unavailable model may use its fallback',async()=>{
  let calls=0;setup(async()=>{calls++;throw Object.assign(new Error('not enough credits'),{status:402});},['test/fallback']);
  try {await assert.rejects(summarize('source text','short'),error=>error.code==='AI_QUOTA_EXHAUSTED');assert.equal(calls,1);}
  finally {config.openRouterKey=original.key;config.openRouterModel=original.model;config.fallbackModels=original.fallback;setOpenRouterClientFactoryForTests();}
  calls=0;setup(async()=>{calls++;if(calls===1)throw Object.assign(new Error('model not found'),{status:404});return{choices:[{message:{content:'fallback'}}]};},['test/fallback']);
  try {assert.equal(await summarize('source text','short'),'fallback');assert.equal(calls,2);}
  finally {config.openRouterKey=original.key;config.openRouterModel=original.model;config.fallbackModels=original.fallback;setOpenRouterClientFactoryForTests();}
});
test('document answers pass retrieved evidence and require evidence-based citations',async()=>{
  let sent;setup(async body=>{sent=body;return{choices:[{message:{content:'Solar panels convert sunlight into electrical energy. [S1]'}}]};});
  try {const result=await answer('What do solar panels convert?',[{text:'Solar panels convert sunlight into electrical energy.'}]);assert.match(result,/\[S1\]/);assert.match(sent.messages[0].content,/exclusively using the source passages/);assert.match(sent.messages[1].content,/Solar panels convert sunlight/);}
  finally {config.openRouterKey=original.key;config.openRouterModel=original.model;config.fallbackModels=original.fallback;setOpenRouterClientFactoryForTests();}
});
