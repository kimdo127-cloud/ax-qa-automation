#!/bin/bash
# 시연 중(1차 QA 뒤): 개발자가 5건 중 3건만 실제로 고친 상황
cd "$(dirname "$0")/../example-site"
python3 - <<'PY'
def sub(f,a,b):
    s=open(f,encoding='utf-8').read(); s=s.replace(a,b,1); open(f,'w',encoding='utf-8').write(s)
sub('style.css','.apply-btn { background: #F04452; }\n','')
sub('courses.html','href="histroy.html"','href="history.html"')
sub('done.html','id="go-history" href="#"','id="go-history" href="history.html"')
PY
cd .. && git add example-site && git commit -q -m "시연: 개발자 수정 3건 반영" && git push -q && echo "수정 3건 배포 요청 완료"
