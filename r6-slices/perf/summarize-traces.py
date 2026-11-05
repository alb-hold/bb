import json,glob,statistics,os
root=os.environ.get('OUT','r6-slices/perf')
rows=[]
for path in glob.glob(root+'/raw/early-*.json'):
 events=json.load(open(path))['traceEvents']
 keys=sorted([e for e in events if e['name']=='EventDispatch' and e.get('args',{}).get('data',{}).get('type')=='keydown'],key=lambda e:e['ts'])
 a,b=keys[:2]
 main=[e for e in events if e.get('ph')=='X' and e.get('pid')==a['pid'] and e.get('tid')==a['tid']]
 tasks=[e for e in main if e['name']=='RunTask' and a['ts']-2000<=e['ts']<b['ts']-2000]
 def total(name):
  spans=sorted((max(a['ts'],e['ts']),min(b['ts'],e['ts']+e.get('dur',0))) for e in main if e['name'] in name and e['ts']<b['ts'] and e['ts']+e.get('dur',0)>a['ts'])
  end=0;s=0
  for l,r in spans:
   s+=max(0,r-max(l,end));end=max(end,r)
  return round(s/1000,3)
 row={'file':path,'busyMs':round(sum(e.get('dur',0) for e in tasks)/1000,3),'threadCpuMs':round(sum(e.get('tdur',0) for e in tasks)/1000,3),'keyWindowMs':round((b['ts']-a['ts'])/1000,3),'scriptingWallMs':total(['FunctionCall','EvaluateScript','v8.evaluateModule','EventDispatch','v8.compile']),'styleMs':total(['UpdateLayoutTree']),'layoutMs':total(['Layout']),'moduleEvaluationMs':total(['v8.evaluateModule','EvaluateScript']),'paintMs':total(['Paint','PrePaint'])}
 row['outsideTasksMs']=round(row['keyWindowMs']-total(['RunTask']),3)
 row['largestTasks']=[{'wallMs':round(e.get('dur',0)/1000,3),'cpuMs':round(e.get('tdur',0)/1000,3),'offsetMs':round((e['ts']-a['ts'])/1000,3)} for e in sorted(tasks,key=lambda e:e.get('dur',0),reverse=True)[:4]]
 rows.append(row)
rows.sort(key=lambda r:(int(r['file'].split('early-')[1].split('-')[0]),int(r['file'].split('-')[-1].split('.')[0])))
json.dump(rows,open(root+'/trace-summary.json','w'),indent=2)
for port in [16800,16830]:
 r=[x for x in rows if f'early-{port}-' in x['file']]
 if r: print(port,'n=',len(r),'median=',statistics.median(x['busyMs'] for x in r),'raw=',[x['busyMs'] for x in r])
