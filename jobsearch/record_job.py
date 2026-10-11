import json, sys, datetime, os

# usage: python3 record_job.py <pane_json> <jk> <page>
#   pane_json = step_job.js output (shape: {ok, jk, page, pane, employerUrl})
pane_path, jk, page = sys.argv[1], sys.argv[2], sys.argv[3]
here = os.path.dirname(os.path.abspath(__file__))
obj = json.load(open(pane_path))
pane = obj.get('pane', obj)                       # accept step_job.js combined shape
if not obj.get('ok', True) or pane.get('error') or not pane.get('title'):
    print('SKIP', jk, '- step failed:', pane.get('error') or obj.get('stage') or 'no title')
    sys.exit(3)
route = pane.get('applyRoute') or 'unknown'
employer = obj.get('employerUrl') or pane.get('employerApplyLink')
rec = {
    'jk': jk,
    'page': int(page),
    'title': pane.get('title'),
    'company': pane.get('company'),
    'location': pane.get('location'),
    'pay': pane.get('pay'),
    'applyRoute': route,
    'employerApplyLink': employer,
    'jobUrl': pane.get('pageUrl'),
    'description': (pane.get('description') or '')[:8000],
    'harvestedAt': datetime.datetime.now().isoformat(timespec='seconds'),
}
path = os.path.join(here, 'jobsuk.json')
try:
    data = [json.loads(l) for l in open(path) if l.strip()]
except Exception:
    data = []
data = [r for r in data if r.get('jk') != jk]
data.append(rec)
with open(path, 'w') as fh:
    for r in data:
        fh.write(json.dumps(r, ensure_ascii=False) + '\n')
print('RECORDED', rec['title'], '@', rec['company'], '|', route, '| page', page, '|', employer or '(indeed-hosted)')
