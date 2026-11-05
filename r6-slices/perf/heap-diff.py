import json,sys,collections,os
from pathlib import Path
base=Path(os.environ.get('OUT','r6-slices/perf'))
a=json.load(open(base/'broad-heap-150.json'));b=json.load(open(base/'broad-heap-300.json'))
print(json.dumps({'selfSizeDeltaByType':{k:b['selfSizeByType'].get(k,0)-a['selfSizeByType'].get(k,0) for k in set(a['selfSizeByType'])|set(b['selfSizeByType'])}},indent=2))
