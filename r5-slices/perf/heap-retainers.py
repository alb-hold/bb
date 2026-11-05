import json
import sys
from collections import defaultdict

p = json.load(open(sys.argv[1]))
m = p['snapshot']['meta']
nodes, edges, strings = p['nodes'], p['edges'], p['strings']
nw, ew = len(m['node_fields']), len(m['edge_fields'])
nf = {k: i for i, k in enumerate(m['node_fields'])}
ef = {k: i for i, k in enumerate(m['edge_fields'])}
nt, et = m['node_types'][0], m['edge_types'][0]

def describe(n):
    return {'id': nodes[n + nf['id']], 'type': nt[nodes[n + nf['type']]], 'name': strings[nodes[n + nf['name']]], 'selfSize': nodes[n + nf['self_size']]}

arrays = sorted((n for n in range(0, len(nodes), nw) if nt[nodes[n + nf['type']]] == 'array'), key=lambda n: nodes[n + nf['self_size']], reverse=True)[:8]
frontier = set(arrays)
seen = set(frontier)
incoming = defaultdict(list)
for depth in range(8):
    next_frontier = set()
    e = 0
    for n in range(0, len(nodes), nw):
        end = e + nodes[n + nf['edge_count']] * ew
        for k in range(e, end, ew):
            target = edges[k + ef['to_node']]
            if target not in frontier:
                continue
            kind = et[edges[k + ef['type']]]
            if kind == 'weak':
                continue
            name = edges[k + ef['name_or_index']]
            label = name if kind in ('element', 'hidden') else strings[name]
            incoming[target].append({'from': describe(n), 'edge': f'{kind}:{label}'})
            if n not in seen:
                next_frontier.add(n)
        e = end
    frontier = set(sorted(next_frontier)[:600])
    seen.update(frontier)
    if not frontier:
        break
json.dump({'file': sys.argv[1], 'largestArrays': [describe(n) for n in arrays], 'incoming': {str(describe(n)['id']): v for n, v in incoming.items()}}, sys.stdout, indent=2)
