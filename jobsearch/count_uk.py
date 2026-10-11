import json
d=[json.loads(l) for l in open('jobsuk.json') if l.strip()]
print('total:',len(d),'| max page:',max(r['page'] for r in d),'| employer-site:',sum(1 for r in d if r['applyRoute']=='employer-site'))
