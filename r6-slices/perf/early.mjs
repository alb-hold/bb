import { chromium } from '/Users/alexandrebrandizzi/ai-infra/deploy-tutano/node_modules/playwright/index.mjs';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
const out = process.env.OUT || 'r6-slices/perf';
mkdirSync(out + '/raw', {recursive:true});
const root = homedir() + '/Library/Caches/ms-playwright/chromium_headless_shell-1247';
const browser = await chromium.launch({ executablePath: root + '/' + readdirSync(root).find(d => d.startsWith('chrome')) + '/chrome-headless-shell' });
const result = {loadBefore:loadavg(), runs:[]};
try {
for (let i=0;i<Number(process.env.RUNS || 18);i++) for(const port of (i%2 ? [16830,16800] : [16800,16830]).filter(p=>!process.env.PORT || p===Number(process.env.PORT))) {
 const ctx=await browser.newContext({viewport:{width:1280,height:800}});
 const page=await ctx.newPage();
 const cdp=await ctx.newCDPSession(page);
 const events=[];
 cdp.on('Tracing.dataCollected',d=>events.push(...d.value));
 const done=new Promise(r=>cdp.once('Tracing.tracingComplete',r));
 await cdp.send('Tracing.start',{categories:'toplevel,devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline,v8',transferMode:'ReportEvents'});
 await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'commit'});
 const composer=page.locator('textarea, [contenteditable=true]').first();
 await composer.waitFor({state:'visible'});
 await composer.evaluate(e=>{e.focus();performance.mark('composer-ready')});
 await page.waitForTimeout(40);
 await page.keyboard.type('a');
 await page.waitForTimeout(40);
 await page.keyboard.type('b');
 await page.waitForTimeout(500);
 await cdp.send('Tracing.end');await done;
 writeFileSync(`${out}/raw/early-${port}-${i}.json`,JSON.stringify({traceEvents:events}));
 const keys=events.filter(e=>e.name==='EventDispatch'&&e.args?.data?.type==='keydown').sort((a,b)=>a.ts-b.ts);
 const [first,next]=keys;
 const ready=events.find(e=>e.name==='composer-ready');
 const same=e=>e.pid===first.pid&&e.tid===first.tid&&e.ph==='X'&&e.dur;
 const tasks=events.filter(e=>same(e)&&e.name==='RunTask'&&e.ts>=first.ts-2000&&e.ts<next.ts-2000);
 const finish=tasks.reduce((m,e)=>Math.max(m,e.ts+e.dur),first.ts);
 const work=events.filter(e=>same(e)&&e.ts>=first.ts-2000&&e.ts<next.ts-2000&&['EventDispatch','EvaluateScript','FunctionCall','UpdateLayoutTree','Layout','Paint','PrePaint','FireIdleCallback','v8.compile','v8.evaluateModule','TimerFire'].includes(e.name)).map(e=>({name:e.name,ms:e.dur/1000,cpuMs:(e.tdur??0)/1000,offsetMs:(e.ts-first.ts)/1000,url:e.args?.data?.url || e.args?.data?.scriptName}));
 const row={port,run:i,firstKeyMainThreadBusyMs:tasks.reduce((s,e)=>s+e.dur,0)/1000,firstKeyThreadCpuMs:tasks.reduce((s,e)=>s+(e.tdur??0),0)/1000,firstKeyAfterReadyMs:(first.ts-ready.ts)/1000,windowMs:(next.ts-first.ts)/1000,work,postTaskGapMs:(next.ts-finish)/1000,devtools:await page.evaluate(()=>typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__)};
 result.runs.push(row);console.log(JSON.stringify(row));
 await ctx.close();
}
} finally {await browser.close();result.loadAfter=loadavg();writeFileSync(out+'/early.json',JSON.stringify(result,null,2))}
