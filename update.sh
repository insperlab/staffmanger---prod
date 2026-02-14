#!/bin/bash
cp ~/Downloads/*.html . 2>/dev/null
cp ~/Downloads/*.js netlify/functions/ 2>/dev/null
netlify deploy --prod --dir=.
echo "✅ 배포 완료!"
