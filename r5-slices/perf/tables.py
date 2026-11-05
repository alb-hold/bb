import json,statistics,pathlib,re
root=pathlib.Path('r5-slices/perf');r=json.loads((root/'ab.json').read_text());out=['| Probe | Port | n | Task wall ms median [range] | Thread CPU ms median [range] | JS sampled self ms median [range] |','|---|---:|---:|---|---|---|']
for mode in ['adapter-ready','settled']:
 for port in [16800,16820]:
  rows=[x for x in r if x['mode']==mode and x['port']==port]
  if not rows:continue
  def fmt(k):
   v=[x[k]for x in rows];return f'{statistics.median(v):.3f} [{min(v):.3f}, {max(v):.3f}]'
  out.append(f'| {mode} | {port} | {len(rows)} | {fmt("taskWallMs")} | {fmt("taskThreadCpuMs")} | {fmt("jsSelfMs")} |')
(root/'ab-table.md').write_text('\n'.join(out)+'\n')
for name,prefix in [('soak-shared-plugin','footprint'),('candidate-soak','footprint-candidate'),('broad-soak','footprint-broad')]:
 p=root/(name+'.json')
 if not p.exists():continue
 out=['| Nav | Distinct threads | Terminal visits | Heap MiB | DOM nodes | Listeners | Connected | Live xterm | Live WebGL | Renderer footprint MB (shared PID; may include slice B) |','|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|']
 for x in json.loads(p.read_text()):
  f=root/f'{prefix}-{x["navigation"]}.txt';s=f.read_text()if f.exists()else'';m=re.search(r'phys_footprint:\s*(.*)',s)
  out.append(f'| {x["navigation"]} | {x.get("distinctThreads","not recorded")} | {x["terminalVisits"]} | {x["heapMiB"]:.2f} | {x["nodes"]} | {x["jsEventListeners"]} | {x["connected"]} | {x.get("liveXterm","not sampled")} | {x.get("liveWebGL","not sampled")} | {(m[1]+"; shared PID, may include B; snapshot overhead possible") if m else "unavailable: see raw footprint output"} |')
 (root/(name+'-table.md')).write_text('\n'.join(out)+'\n')
