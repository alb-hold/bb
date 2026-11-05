# Extension-free soak
One browser run; n=1 per checkpoint. Each cell is its raw value and median. Forced GC twice before sampling.
| Navigation | Heap MiB | DOM nodes | Listeners | Live xterm | Live WebGL |
|---:|---:|---:|---:|---:|---:|
|0|44.988445|1450|810|1|1|
|50|63.399895|2650|1114|0|0|
|150|66.720676|2656|1117|0|0|
|200|66.276165|2672|1117|0|0|
|300|67.229115|2656|1117|0|0|

150 to 300 heap delta: 0.7620398017772478%; DOM delta: 0.0%.
Raw: broad-soak.json. Snapshots: raw/broad-{0,150,300}.heapsnapshot.
