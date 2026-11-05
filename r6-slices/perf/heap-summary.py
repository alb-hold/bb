import json,sys,collections
p=json.load(open(sys.argv[1]));m=p['snapshot']['meta'];ns=p['nodes'];es=p['edges'];ss=p['strings'];nw=len(m['node_fields']);ew=len(m['edge_fields']);ni={k:i for i,k in enumerate(m['node_fields'])};ei={k:i for i,k in enumerate(m['edge_fields'])};prop=m['edge_types'][0].index('property');edge=0;terms=[];webgl=collections.Counter();sizes=collections.Counter();types=collections.Counter()
for n in range(0,len(ns),nw):
 count=ns[n+ni['edge_count']];name=ss[ns[n+ni['name']]];typ=m['node_types'][0][ns[n+ni['type']]];size=ns[n+ni['self_size']];sizes[(typ,name)]+=size;types[typ]+=size;names=set()
 for e in range(edge,edge+count*ew,ew):
  if es[e+ei['type']]==prop:names.add(ss[es[e+ei['name_or_index']]])
 if {'_core','_addonManager','_publicOptions'}<=names:terms.append(ns[n+ni['id']])
 if typ=='native' and 'WebGL' in name:webgl[name]+=1
 edge+=count*ew
json.dump({'file':sys.argv[1],'xtermWrappers':len(terms),'terminalIds':terms,'webglNative':dict(webgl),'selfSizeByType':dict(types),'topSizes':[(str(k),v) for k,v in sizes.most_common(30)]},sys.stdout,indent=2)
