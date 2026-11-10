#!/bin/bash
# 시연 시작 전: 예제 사이트를 오류 5개가 있는 상태로 되돌린다
cd "$(dirname "$0")/../example-site"
python3 - <<'PY'
def sub(f,a,b):
    s=open(f,encoding='utf-8').read()
    if b in s: return
    assert a in s,(f,a); open(f,'w',encoding='utf-8').write(s.replace(a,b,1))
sub('style.css','.empty {','.apply-btn { background: #F04452; }\n.empty {')
sub('courses.html','id="tab-history" href="history.html"','id="tab-history" href="histroy.html"')
sub('done.html','id="go-history" href="history.html"','id="go-history" href="#"')
PY
cd .. && git add example-site && git commit -q -m "시연: 예제 사이트 오류 상태" && git push -q && echo "오류 상태 배포 요청 완료"
