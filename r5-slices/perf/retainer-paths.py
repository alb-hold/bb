import json
import sys
from collections import deque

p = json.load(open(sys.argv[1]))
out = []
for array in p['largestArrays']:
    queue = deque([(array['id'], [])])
    seen = set()
    found = None
    while queue:
        current, path = queue.popleft()
        if current in seen or len(path) > 9:
            continue
        seen.add(current)
        for edge in p['incoming'].get(str(current), []):
            chain = path + [edge]
            if edge['edge'] == 'property:rendererInterfaces':
                found = chain
                break
            queue.append((edge['from']['id'], chain))
        if found:
            break
    out.append({'array': array, 'pathToRendererInterfaces': found})
json.dump(out, sys.stdout, indent=2)
