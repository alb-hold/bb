import json,collections,os
from pathlib import Path
root=Path(os.environ.get('OUT','r6-slices/perf'))
a=json.load(open(root/'raw/broad-150.heapsnapshot')); w=len(a['snapshot']['meta']['node_fields']); ids=set(a['nodes'][2::w]); del a
p=json.load(open(root/'raw/broad-300.heapsnapshot'));m=p['snapshot']['meta'];ns=p['nodes'];es=p['edges'];ss=p['strings'];nw=len(m['node_fields']);ew=len(m['edge_fields']);nf={k:i for i,k in enumerate(m['node_fields'])};ef={k:i for i,k in enumerate(m['edge_fields'])};nt=m['node_types'][0];et=m['edge_types'][0]
def desc(n):return {'id':ns[n+nf['id']],'type':nt[ns[n+nf['type']]],'name':ss[ns[n+nf['name']]],'bytes':ns[n+nf['self_size']]}
new=[n for n in range(0,len(ns),nw) if ns[n+nf['id']] not in ids]
targets=[]
for typ in ['array','object','native','string']:
 targets+=sorted([n for n in new if nt[ns[n+nf['type']]]==typ],key=lambda n:ns[n+nf['self_size']],reverse=True)[:2]
front=set(targets);seen=set(front);incoming=collections.defaultdict(list)
for depth in range(12):
 nxt=set();e=0
 for n in range(0,len(ns),nw):
  end=e+ns[n+nf['edge_count']]*ew
  for k in range(e,end,ew):
   t=es[k+ef['to_node']];kind=et[es[k+ef['type']]]
   if t not in front or kind=='weak':continue
   raw=es[k+ef['name_or_index']];label=str(raw) if kind in ['element','hidden'] else ss[raw]
   incoming[t].append((n,kind+':'+label))
   if n not in seen:nxt.add(n)
  e=end
 front=set(sorted(nxt)[:1200]);seen.update(front)
 if not front:break
out=[]
for t in targets:
 q=collections.deque([(t,[])]);visited=set();found=None
 while q:
  n,path=q.popleft()
  if n in visited:continue
  visited.add(n)
  if n==0:found=path;break
  for parent,label in incoming[n]:q.append((parent,path+[{'via':label,'from':desc(parent)}]))
 out.append({'newRetainer':desc(t),'pathToRoot':found,'immediateRetainers':[{'via':label,'from':desc(parent)} for parent,label in incoming[t]][:8]})
json.dump(out,open(root/'retainer-paths.json','w'),indent=2)
