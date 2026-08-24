# Gates: Herdr release-level support documentation

Scope: repair the three-language Herdr support documentation and README navigation until the independent Fable judge accepts the release contract.

- [x] G1: The working tree is based on the merged Herdr parser baseline used by the support claims.
  CHECK: git merge-base --is-ancestor d8176cc HEAD && git grep -q "custom_tool_call" server/helpers.js && git grep -q "use_tool" server/helpers.js && echo baseline-ok
  EXPECT: baseline-ok
  EVIDENCE: baseline-ok

- [x] G2: English, Traditional Chinese, and Japanese guides each define the complete support legend and use the same four status meanings.
  CHECK: node -e "const fs=require('fs'); const files=['docs/herdr-support.md','docs/herdr-support.zh-TW.md','docs/herdr-support.ja.md']; const ok=files.every(f=>fs.existsSync(f)&&/✅/.test(fs.readFileSync(f,'utf8'))&&/△/.test(fs.readFileSync(f,'utf8'))&&/❌/.test(fs.readFileSync(f,'utf8'))&&/—/.test(fs.readFileSync(f,'utf8'))); if(!ok) process.exit(1); console.log('legend-ok')"
  EXPECT: legend-ok
  EVIDENCE: legend-ok

- [x] G3: All three guides carry the same semantic support contract, including notifications, not-linked identity safety, Weather/default-off behavior, reversible sidebar changes, context-window provenance, reset-time qualification, source-of-truth references, and the known plugin limitations.
  CHECK: node -e "const fs=require('fs'); const terms=['Notifications','not linked','Weather','reversible','Context window','Reset time','source of truth','lower bound','duplicate']; const files=['docs/herdr-support.md','docs/herdr-support.zh-TW.md','docs/herdr-support.ja.md']; const isGlossaryLine=line=>{const s=line.toLowerCase(); return terms.every(t=>s.includes(t.toLowerCase()))}; const ok=files.every(f=>{const lines=fs.readFileSync(f,'utf8').split(/\r?\n/); const glossaryLines=lines.filter(isGlossaryLine); const body=lines.filter(line=>!isGlossaryLine(line)).join('\n').toLowerCase(); return glossaryLines.length===1&&terms.every(t=>body.includes(t.toLowerCase()))}); if(!ok) process.exit(1); console.log('semantic-parity-ok')"
  EXPECT: semantic-parity-ok
  EVIDENCE: semantic-parity-ok

- [x] G4: Capability claims distinguish complete support from observation-dependent or heuristic support, and every such limitation points to the wire/confidence evidence.
  CHECK: node -e "const fs=require('fs'); const files=['docs/herdr-support.md','docs/herdr-support.zh-TW.md','docs/herdr-support.ja.md']; const ok=files.every(f=>{const s=fs.readFileSync(f,'utf8'); return s.includes('wire-protocol-reference.md')&&s.includes('△')}); if(!ok) process.exit(1); console.log('confidence-claims-ok')"
  EXPECT: confidence-claims-ok
  EVIDENCE: confidence-claims-ok

- [x] G5: The three guides expose a symmetric language switch at the top, and all README entry points target the matching guide.
  CHECK: node -e "const fs=require('fs'); const files=['docs/herdr-support.md','docs/herdr-support.zh-TW.md','docs/herdr-support.ja.md']; const ok=files.every(f=>{const s=fs.readFileSync(f,'utf8'); return files.every(g=>s.includes(g.replace('docs/','')))}); if(!ok) process.exit(1); console.log('language-switch-ok')"
  EXPECT: language-switch-ok
  EVIDENCE: language-switch-ok

- [x] G6: README.md and README.zh-TW.md use `### Herdr plugin`, README.ja.md uses `### Herdr プラグイン`, and all four README entry points have parallel Herdr installation/quick-start structure and language-appropriate links.
  CHECK: node -e "const fs=require('fs'); const specs=[['README.md','### Herdr plugin',['docs/herdr-support.md']],['README.zh-TW.md','### Herdr plugin',['docs/herdr-support.zh-TW.md']],['README.ja.md','### Herdr プラグイン',['docs/herdr-support.ja.md']],['plugins/herdr/README.md',null,['../../docs/herdr-support.md','../../docs/herdr-support.zh-TW.md','../../docs/herdr-support.ja.md']]]; const install=/herdr plugin install[\s\S]*herdr plugin action invoke/; const ok=specs.every(([file,heading,targets])=>{const s=fs.readFileSync(file,'utf8'); return (!heading||s.split(/\r?\n/).includes(heading))&&install.test(s)&&targets.every(target=>s.includes(target))}); if(!ok) process.exit(1); console.log('readme-entry-ok')"
  EXPECT: readme-entry-ok
  EVIDENCE: readme-entry-ok

- [x] G7: All relative Markdown links in the changed documentation resolve, every resolved relative Markdown target is git-tracked, the two localized guides are explicitly git-tracked, and the diff has no whitespace errors.
  CHECK: git diff --check && git ls-files --error-unmatch docs/herdr-support.zh-TW.md docs/herdr-support.ja.md >/dev/null && node -e "const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process'); const files=['README.md','README.zh-TW.md','README.ja.md','plugins/herdr/README.md','docs/herdr-support.md','docs/herdr-support.zh-TW.md','docs/herdr-support.ja.md','docs/wire-protocol-reference.md']; const re=/\]\(([^)#]+)(?:#[^)]+)?\)/g; for(const f of files){const s=fs.readFileSync(f,'utf8'); let m; while((m=re.exec(s))){const target=m[1]; if(/^(https?:|mailto:|#)/.test(target)) continue; const p=path.resolve(path.dirname(f),target); if(!fs.existsSync(p)) throw new Error(f+' -> '+target); if(path.extname(p).toLowerCase()==='.md'){const rel=path.relative(process.cwd(),p); try{execFileSync('git',['ls-files','--error-unmatch','--',rel],{stdio:'ignore'})}catch{throw new Error('untracked Markdown target: '+f+' -> '+target)}}}} console.log('links-and-tracked-ok')"
  EXPECT: links-and-tracked-ok
  EVIDENCE: links-and-tracked-ok

- [x] G8: An independent Fable review has checked every finding against the gates and explicitly says either CONTINUE or RELEASE.
  EVIDENCE: Native Fable current-diff review explicitly returned `VERDICT: RELEASE`; Claude independently verified the cited current-tree evidence.

- [x] G9: Final verification was run after the last Fable response, with every automated gate passing and no unresolved manual finding.
  CHECK: node -e "const fs=require('fs'); const lines=fs.readFileSync('GATES.md','utf8').split(/\r?\n/); const gates=[]; for(let i=0;i<lines.length;i++){const match=lines[i].match(/^- \[([ xX])\] G(\d+):/); if(!match) continue; let evidence=''; for(let j=i+1;j<lines.length&&!/^- \[/.test(lines[j]);j++){const found=lines[j].match(/^  EVIDENCE:\s*(.*)$/); if(found) evidence=found[1].trim()} gates.push({id:Number(match[2]),checked:/x/i.test(match[1]),evidence})} const preceding=gates.filter(gate=>gate.id<9); const bad=preceding.filter(gate=>!gate.checked||!gate.evidence||/^pending\b/i.test(gate.evidence)); if(preceding.length!==8||!preceding.every((gate,index)=>gate.id===index+1)||bad.length){console.error('final gates not ready: '+(bad.map(gate=>'G'+gate.id).join(', ')||'missing preceding gate')); process.exit(1)} console.log('final-gates-ok')"
  EXPECT: final-gates-ok
  EVIDENCE: final-gates-ok
