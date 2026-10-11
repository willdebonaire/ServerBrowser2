import json, re
d = json.load(open('jobs.json'))
def classify(r):
    desc = r.get('description') or ''
    ratio = sum(1 for c in desc if '\u0e00' <= c <= '\u0e7f') / max(len(desc), 1)
    m = {'jk': r['jk'], 'title': r['title'], 'company': r['company'], 'route': r['applyRoute'],
         'link': r.get('employerApplyLink'), 'thai_pct': round(ratio*100),
         'english_mentioned': bool(re.search(r'ภาษาอังกฤษ|English', desc, re.I))}
    if re.search(r'ภาษาไทย|Good Thai|Thai language|\bThai\b', desc, re.I):
        m['verdict'] = 'REVIEW: Thai language mentioned'
    elif ratio > 35:
        m['verdict'] = 'REVIEW: posted in Thai'
    elif m['english_mentioned']:
        m['verdict'] = 'APPLY: English explicitly welcomed'
    elif ratio < 5:
        m['verdict'] = 'APPLY: English post, no Thai req'
    else:
        m['verdict'] = 'REVIEW: mixed'
    return m
rows = sorted((classify(r) for r in d), key=lambda m: (0 if m['verdict'].startswith('APPLY') else 1, -m['thai_pct']))
json.dump({'apply_queue': [m for m in rows if m['verdict'].startswith('APPLY')],
           'review_list': [m for m in rows if m['verdict'].startswith('REVIEW')]},
          open('triage.json', 'w'), ensure_ascii=False, indent=1)
for m in rows:
    tag = 'EN' if m['english_mentioned'] else '  '
    print(m['verdict'][:36].ljust(36), '|', (m['title'] or '')[:32].ljust(32), '|', (m['company'] or '')[:20].ljust(20), '| thai%', str(m['thai_pct']).rjust(2), tag)
