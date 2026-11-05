import json
import sys
from array import array

p = json.load(open(sys.argv[1]))
m = p['snapshot']['meta']
nodes, edges, strings = p['nodes'], p['edges'], p['strings']
nw, ew = len(m['node_fields']), len(m['edge_fields'])
nf = {k: i for i, k in enumerate(m['node_fields'])}
ef = {k: i for i, k in enumerate(m['edge_fields'])}
nt, et = m['node_types'][0], m['edge_types'][0]
offsets = array('I')
offset = 0
roots = {}
for n in range(0, len(nodes), nw):
    offsets.append(offset)
    offset += nodes[n + nf['edge_count']] * ew
    if nodes[n + nf['id']] in (862417, 3592539):
        roots[nodes[n + nf['id']]] = n
out = []
for identity, root in roots.items():
    stack, seen = [root], set()
    array_count = size = entries = 0
    while stack:
        n = stack.pop()
        if n in seen:
            continue
        seen.add(n)
        typ, name = nt[nodes[n + nf['type']]], strings[nodes[n + nf['name']]]
        if not (typ == 'array' or typ == 'object' and name == 'Array'):
            continue
        size += nodes[n + nf['self_size']]
        array_count += 1
        start = offsets[n // nw]
        for e in range(start, start + nodes[n + nf['edge_count']] * ew, ew):
            kind = et[edges[e + ef['type']]]
            label = edges[e + ef['name_or_index']]
            if kind == 'element' or kind == 'internal' and strings[label] == 'elements':
                stack.append(edges[e + ef['to_node']])
                if n == root and kind == 'element':
                    entries += 1
    out.append({'rootId': identity, 'directEntries': entries, 'arrayNodes': array_count, 'arraySelfBytes': size})
json.dump({'file': sys.argv[1], 'devtoolsLtQueues': out, 'totalArraySelfBytes': sum(x['arraySelfBytes'] for x in out)}, sys.stdout, indent=2)
