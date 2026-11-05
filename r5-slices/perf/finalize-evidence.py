import json
from pathlib import Path

root = Path('r5-slices/perf')
rows = json.loads((root / 'broad-soak.json').read_text())
visits = json.loads((root / 'broad-visits.json').read_text())
last = rows[-1]
assert last['navigation'] == 300 and len(visits) == 300
assert last['terminalVisits'] >= 40 and last['distinctThreads'] >= 50
assert last['panels'] == 12 and last['palettes'] == 12 and last['scrolls'] >= 20
assert len({v['id'] for v in visits}) == last['distinctThreads']
snapshots = {n: json.loads((root / f'broad-heap-{n}.json').read_text()) for n in (0, 150, 300)}
summary = {
    'sourceSha': '8e616a15e61fec57da8c5aef6680c50287dc8c80',
    'navigations': len(visits),
    'distinctThreads': last['distinctThreads'],
    'nativeVisits': last['terminalVisits'],
    'panelCycles': last['panels'],
    'paletteCycles': last['palettes'],
    'longThreadScrolls': last['scrolls'],
    'heapMiB': {'initial': rows[0]['heapMiB'], 'final': last['heapMiB'], 'min': min(r['heapMiB'] for r in rows), 'max': max(r['heapMiB'] for r in rows)},
    'snapshots': {n: {'wrapperCount': s['xtermWrappers'], 'totalSelfMiB': sum(s['selfSizeByType'].values()) / 1048576} for n, s in snapshots.items()},
    'snapshotTypeDeltaBytes': {k: snapshots[300]['selfSizeByType'].get(k, 0) - v for k, v in snapshots[0]['selfSizeByType'].items()},
}
(root / 'broad-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
table = ['| Snapshot navigation | Wrapper-shaped instances | Total self MiB, including native |', '|---:|---:|---:|']
for n, s in summary['snapshots'].items():
    table.append(f'| {n} | {s["wrapperCount"]} | {s["totalSelfMiB"]:.2f} |')
(root / 'snapshot-table.md').write_text('\n'.join(table) + '\n')
packet = {
    'schema_version': 1,
    'operation': 'claim_e2e_complete',
    'actor': {'verified': True, 'persona': 'developer in owner-provided seeded workspace', 'surface': 'BB production preview', 'environment': 'http://127.0.0.1:16820 desktop 1280x800; product source ' + summary['sourceSha']},
    'entrypoint': {'verified': True, 'route': '/threads/thr_ti5myaruiv', 'evidence': 'broad-soak.json navigation 0: mounted xterm and canvas, own target 269F876CEB09E6AEFD0AAAA289FD157B'},
    'authentication': {'required': False, 'initial_state': 'not_required', 'state': 'not_required', 'evidence': 'Owner-provided local seeded API; native and chat content reached without login or credentials'},
    'prerequisites': {'verified': True, 'evidence': 'seeded-chat-ids.json; broad-visits.json', 'items': [{'name': '60 unique seeded chat records and native/long threads', 'available': True, 'obtained_by': 'read-only seeded API list and mounted UI content', 'evidence': 'broad-visits.json: every SPA visit records mounted chat rows or native terminal'}]},
    'journey': {'walked': True, 'same_actor': True, 'same_surface': True, 'evidence': 'broad-soak.json, broad-visits.json and checks/broad-soak.log', 'steps': [
        {'page': 'Chat and native terminal', 'control': 'Thread navigation', 'surface': 'BB production preview', 'observed': True, 'evidence': f'300 mounted visits; {last["distinctThreads"]} distinct threads; {last["terminalVisits"]} native visits; stable performance.timeOrigin'},
        {'page': 'Thread', 'control': 'Show/Hide right panel and Cmd+Shift+P/Escape', 'surface': 'BB production preview', 'observed': True, 'evidence': '12 successful panel and palette open-close cycles asserted by mounted controls and palette testid'},
        {'page': 'Long chat', 'control': 'Timeline scrolling', 'surface': 'BB production preview', 'observed': True, 'evidence': f'{last["scrolls"]} long-thread scroll cycles; mounted scroll container asserted'},
    ]},
    'terminal': {'status': 'passed', 'evidence': 'Read-only navigation measurement journey only. Does not establish canonical first-key target or installed-app day-long memory behavior.'},
}
(root / 'raw/qa-measurement-evidence.json').write_text(json.dumps(packet, indent=2) + '\n')
print(json.dumps(summary, indent=2))
